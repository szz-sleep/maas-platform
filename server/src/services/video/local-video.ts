/**
 * Generic local-video provider layer.
 *
 * v3 lifecycle management:
 * - public task ids remain short UUIDs (lv_*)
 * - legacy v1 Redis/encoded task ids remain readable
 * - new tasks are prepared + material-probed first, then queued in Redis
 * - only the queue worker submits work to the local video backend
 * - GET polling acts as a heartbeat (lastSeenAt)
 * - orphaned queued tasks are removed before they reach the backend
 * - orphaned running tasks are not force-aborted; they are discarded after completion
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import prisma from '../../config/database';
import { getRedis } from '../../config/redis';
import {
  deleteMinimaxH3Task,
  getMinimaxH3ActiveTaskCount,
  getMinimaxH3Content,
  getMinimaxH3Task,
  MinimaxH3Config,
  MinimaxH3PreparedTask,
  MinimaxH3RequestError,
  prepareMinimaxH3Task,
  submitMinimaxH3PreparedTask,
} from './minimax-h3';

type LocalVideoProvider = 'minimax-h3';
type LocalTaskState = 'queued' | 'submitting' | 'running' | 'succeeded' | 'failed';

interface LocalTaskEnvelopeV1 {
  v: 1;
  provider: LocalVideoProvider;
  model: string;
  nativeId: string;
}

interface LocalTaskEnvelopeV2 {
  v: 2;
  provider: LocalVideoProvider;
  model: string;
  state: LocalTaskState;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  nativeId?: string;
  providerStatus?: string;
  progress?: number;
  error?: string;
  abandoned?: boolean;
  prepared?: MinimaxH3PreparedTask;
  effectiveParams: Record<string, unknown>;
}

type LocalTaskEnvelope = LocalTaskEnvelopeV1 | LocalTaskEnvelopeV2;

export class LocalVideoRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'LocalVideoRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const SHORT_TASK_PREFIX = 'lv_';
const LEGACY_TASK_PREFIX = 'lv1_';
const REDIS_TASK_KEY_PREFIX = 'maas:local-video:task:';
const REDIS_QUEUE_KEY_PREFIX = 'maas:local-video:queue:';
const REDIS_RUNNING_KEY_PREFIX = 'maas:local-video:running:';
const REDIS_WORKER_LOCK_PREFIX = 'maas:local-video:worker-lock:';
const REDIS_HEARTBEAT_PREFIX = 'maas:local-video:heartbeat:';
const WORKER_PROVIDER: LocalVideoProvider = 'minimax-h3';

let workerTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let workerBusy = false;
let sweepBusy = false;
let workerStopping = false;

function configJson(modelRecord: any): Record<string, any> {
  return modelRecord?.config && typeof modelRecord.config === 'object'
    ? modelRecord.config as Record<string, any>
    : {};
}

function providerOf(modelRecord: any): LocalVideoProvider | null {
  if (!modelRecord || modelRecord.source !== 'local' || modelRecord.modelType !== 'video') {
    return null;
  }

  const config = configJson(modelRecord);
  const value = String(config.videoProvider || config.adapter || '').toLowerCase();

  if (value === 'minimax-h3' || value === 'minimax-h3-vllm-omni') {
    return 'minimax-h3';
  }

  return null;
}

function h3Config(modelRecord: any): MinimaxH3Config {
  const cfg = configJson(modelRecord);

  return {
    endpointRef2VA: cfg.endpointRef2VA,
    ref2vaEnabled: Boolean(cfg.ref2vaEnabled),
    defaults: cfg.defaults || cfg.videoDefaults,
    limits: cfg.limits,
  };
}

function taskTtlSeconds(): number {
  const parsed = Number(process.env.LOCAL_VIDEO_TASK_TTL_SECONDS || 604800);
  if (!Number.isFinite(parsed)) return 604800;
  return Math.max(3600, Math.trunc(parsed));
}

function queueLimit(): number {
  const parsed = Number(process.env.LOCAL_VIDEO_QUEUE_LIMIT || 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function orphanTimeoutMs(): number {
  const parsed = Number(process.env.LOCAL_VIDEO_ORPHAN_TIMEOUT_SECONDS || 180);
  if (!Number.isFinite(parsed)) return 180_000;
  return Math.max(60, Math.trunc(parsed)) * 1000;
}

function workerIntervalMs(): number {
  const parsed = Number(process.env.LOCAL_VIDEO_WORKER_INTERVAL_MS || 2000);
  if (!Number.isFinite(parsed)) return 2000;
  return Math.max(500, Math.trunc(parsed));
}

function sweepIntervalMs(): number {
  const parsed = Number(process.env.LOCAL_VIDEO_SWEEP_INTERVAL_MS || 60000);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.max(10_000, Math.trunc(parsed));
}

function runningKeyTtlSeconds(): number {
  const parsed = Number(process.env.LOCAL_VIDEO_RUNNING_KEY_TTL_SECONDS || 7200);
  if (!Number.isFinite(parsed)) return 7200;
  return Math.max(600, Math.trunc(parsed));
}

function redisTaskKey(taskId: string): string {
  return `${REDIS_TASK_KEY_PREFIX}${taskId}`;
}

function redisQueueKey(provider: LocalVideoProvider): string {
  return `${REDIS_QUEUE_KEY_PREFIX}${provider}`;
}

function redisRunningKey(provider: LocalVideoProvider): string {
  return `${REDIS_RUNNING_KEY_PREFIX}${provider}`;
}

function redisWorkerLockKey(provider: LocalVideoProvider): string {
  return `${REDIS_WORKER_LOCK_PREFIX}${provider}`;
}

function redisHeartbeatKey(taskId: string): string {
  return `${REDIS_HEARTBEAT_PREFIX}${taskId}`;
}

function createShortTaskId(): string {
  return `${SHORT_TASK_PREFIX}${randomUUID()}`;
}

function isV2Task(task: LocalTaskEnvelope): task is LocalTaskEnvelopeV2 {
  return task.v === 2;
}

async function saveTask(taskId: string, task: LocalTaskEnvelope): Promise<void> {
  await getRedis().set(
    redisTaskKey(taskId),
    JSON.stringify(task),
    'EX',
    taskTtlSeconds(),
  );
}

async function deleteTask(taskId: string): Promise<void> {
  await getRedis().del(redisTaskKey(taskId), redisHeartbeatKey(taskId));
}

async function touchTaskHeartbeat(taskId: string, now = Date.now()): Promise<void> {
  await getRedis().set(
    redisHeartbeatKey(taskId),
    String(now),
    'EX',
    taskTtlSeconds(),
  );
}

async function taskLastSeenAt(taskId: string, fallback: number): Promise<number> {
  const raw = await getRedis().get(redisHeartbeatKey(taskId));
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function isTaskOrphan(taskId: string, fallback: number): Promise<boolean> {
  const lastSeen = await taskLastSeenAt(taskId, fallback);
  return Date.now() - lastSeen > orphanTimeoutMs();
}

function decodeLegacyTask(taskId: string): LocalTaskEnvelopeV1 | null {
  if (!taskId.startsWith(LEGACY_TASK_PREFIX)) return null;

  try {
    const value = JSON.parse(
      Buffer.from(taskId.slice(LEGACY_TASK_PREFIX.length), 'base64url').toString('utf8'),
    );

    if (
      value?.v === 1 &&
      value?.provider === 'minimax-h3' &&
      typeof value?.model === 'string' &&
      typeof value?.nativeId === 'string'
    ) {
      return value as LocalTaskEnvelopeV1;
    }
  } catch {
    // Invalid legacy task id.
  }

  return null;
}

async function loadTask(taskId: string): Promise<LocalTaskEnvelope | null> {
  if (taskId.startsWith(LEGACY_TASK_PREFIX)) {
    return decodeLegacyTask(taskId);
  }

  if (!taskId.startsWith(SHORT_TASK_PREFIX)) {
    return null;
  }

  const raw = await getRedis().get(redisTaskKey(taskId));
  if (!raw) return null;

  try {
    const value = JSON.parse(raw);

    if (
      value?.v === 1 &&
      value?.provider === 'minimax-h3' &&
      typeof value?.model === 'string' &&
      typeof value?.nativeId === 'string'
    ) {
      return value as LocalTaskEnvelopeV1;
    }

    if (
      value?.v === 2 &&
      value?.provider === 'minimax-h3' &&
      typeof value?.model === 'string' &&
      typeof value?.state === 'string' &&
      typeof value?.createdAt === 'number' &&
      typeof value?.lastSeenAt === 'number' &&
      value?.effectiveParams &&
      typeof value.effectiveParams === 'object'
    ) {
      return value as LocalTaskEnvelopeV2;
    }
  } catch {
    // Invalid Redis task value.
  }

  return null;
}

function normalizeStatus(nativeStatus: string): { status: string; providerStatus: string } {
  const value = String(nativeStatus || '').toLowerCase();

  if (['completed', 'succeeded', 'success', 'done', 'finished'].includes(value)) {
    return { status: 'succeeded', providerStatus: value };
  }

  if (['failed', 'error', 'cancelled', 'canceled', 'deleted'].includes(value)) {
    return { status: 'failed', providerStatus: value };
  }

  if (['queued', 'pending', 'created'].includes(value)) {
    return { status: 'queued', providerStatus: value };
  }

  return { status: 'processing', providerStatus: value || 'processing' };
}

function signingSecret(): string {
  const secret =
    process.env.VIDEO_PROXY_SIGNING_SECRET ||
    process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('VIDEO_PROXY_SIGNING_SECRET/JWT_SECRET 未配置');
  }

  return secret;
}

function publicBase(request: any): string {
  const configured = String(process.env.MAAS_PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const headers = request?.headers || {};
  const proto = String(
    headers['x-forwarded-proto'] || request?.protocol || 'http',
  ).split(',')[0].trim();

  const host = String(
    headers['x-forwarded-host'] || headers.host || '127.0.0.1:3001',
  ).split(',')[0].trim();

  return `${proto}://${host}`;
}

function makeSignature(taskId: string, expires: number): string {
  return createHmac('sha256', signingSecret())
    .update(`${taskId}:${expires}`)
    .digest('hex');
}

function signedContentUrl(request: any, taskId: string): string {
  const parsedTtl = Number(process.env.VIDEO_PROXY_URL_TTL_SECONDS || 86400);
  const ttl = Number.isFinite(parsedTtl)
    ? Math.max(60, Math.trunc(parsedTtl))
    : 86400;

  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = makeSignature(taskId, expires);

  return `${publicBase(request)}/v1/video/generations/${encodeURIComponent(taskId)}/content?expires=${expires}&signature=${signature}`;
}

function toLocalVideoError(err: unknown): LocalVideoRequestError {
  if (err instanceof LocalVideoRequestError) return err;
  if (err instanceof MinimaxH3RequestError) {
    return new LocalVideoRequestError(err.code, err.message, err.statusCode);
  }
  return new LocalVideoRequestError(
    'LOCAL_VIDEO_CREATE_FAILED',
    err instanceof Error ? err.message : String(err),
    500,
  );
}

async function enqueueTask(taskId: string, provider: LocalVideoProvider): Promise<number> {
  const script = `
    local queued = redis.call('LLEN', KEYS[1])
    local running = redis.call('EXISTS', KEYS[2])
    local limit = tonumber(ARGV[1])
    if (queued + running) >= limit then
      return -1
    end
    redis.call('RPUSH', KEYS[1], ARGV[2])
    return queued + running + 1
  `;

  const result = await getRedis().eval(
    script,
    2,
    redisQueueKey(provider),
    redisRunningKey(provider),
    String(queueLimit()),
    taskId,
  );

  return Number(result);
}

async function removeQueuedTask(taskId: string, provider: LocalVideoProvider): Promise<void> {
  await getRedis().lrem(redisQueueKey(provider), 1, taskId);
}

async function removeQueuedTaskIfOrphan(
  taskId: string,
  provider: LocalVideoProvider,
): Promise<boolean> {
  const script = `
    local last_seen = tonumber(redis.call('GET', KEYS[2]) or '0')
    local now_ms = tonumber(ARGV[2])
    local timeout_ms = tonumber(ARGV[3])
    if last_seen > 0 and (now_ms - last_seen) <= timeout_ms then
      return 0
    end
    local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
    if removed > 0 then
      redis.call('DEL', KEYS[3])
      redis.call('DEL', KEYS[2])
    end
    return removed
  `;

  const result = await getRedis().eval(
    script,
    3,
    redisQueueKey(provider),
    redisHeartbeatKey(taskId),
    redisTaskKey(taskId),
    taskId,
    String(Date.now()),
    String(orphanTimeoutMs()),
  );

  return Number(result) > 0;
}

async function clearRunningIfMatches(taskId: string, provider: LocalVideoProvider): Promise<void> {
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  await getRedis().eval(script, 1, redisRunningKey(provider), taskId);
}

async function acquireWorkerLock(provider: LocalVideoProvider): Promise<string | null> {
  const token = randomUUID();
  const result = await getRedis().set(
    redisWorkerLockKey(provider),
    token,
    'PX',
    600_000,
    'NX',
  );
  return result === 'OK' ? token : null;
}

async function releaseWorkerLock(provider: LocalVideoProvider, token: string): Promise<void> {
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  await getRedis().eval(script, 1, redisWorkerLockKey(provider), token);
}

async function refreshV2FromProvider(
  taskId: string,
  task: LocalTaskEnvelopeV2,
  modelRecord: any,
): Promise<LocalTaskEnvelopeV2> {
  if (!task.nativeId || !['running', 'submitting'].includes(task.state)) {
    return task;
  }

  const native = await getMinimaxH3Task(task.nativeId, h3Config(modelRecord));
  const normalized = normalizeStatus(native.nativeStatus);
  const now = Date.now();

  task.providerStatus = normalized.providerStatus;
  task.updatedAt = now;
  if (native.progress !== undefined) task.progress = native.progress;
  if (native.error) task.error = native.error;

  if (normalized.status === 'succeeded') {
    task.state = 'succeeded';
    task.progress = 100;
    await saveTask(taskId, task);
    await clearRunningIfMatches(taskId, task.provider);
    return task;
  }

  if (normalized.status === 'failed') {
    task.state = 'failed';
    task.error = native.error || `MiniMax-H3 任务失败 (${normalized.providerStatus})`;
    await saveTask(taskId, task);
    await clearRunningIfMatches(taskId, task.provider);
    return task;
  }

  task.state = 'running';
  await saveTask(taskId, task);
  return task;
}

export function supportsLocalVideoModel(modelRecord: any): boolean {
  return providerOf(modelRecord) !== null;
}

export function isLocalVideoTaskId(taskId: string): boolean {
  return taskId.startsWith(SHORT_TASK_PREFIX) || taskId.startsWith(LEGACY_TASK_PREFIX);
}

export function localVideoErrorStatus(err: unknown): number {
  const statusCode = Number((err as any)?.statusCode);
  return Number.isFinite(statusCode) && statusCode >= 400 && statusCode <= 599
    ? Math.trunc(statusCode)
    : 500;
}

export function localVideoErrorCode(err: unknown, fallback = 'LOCAL_VIDEO_ERROR'): string {
  const code = String((err as any)?.code || '').trim();
  return code || fallback;
}

export async function createLocalVideoTask(modelRecord: any, body: any): Promise<any> {
  const provider = providerOf(modelRecord);

  if (!provider) {
    throw new LocalVideoRequestError(
      'LOCAL_VIDEO_PROVIDER_UNSUPPORTED',
      `本地视频模型 "${modelRecord?.name || '(unknown)'}" 未配置受支持的 videoProvider`,
      400,
    );
  }

  if (modelRecord.status !== 'online') {
    throw new LocalVideoRequestError(
      'MODEL_OFFLINE',
      `模型 "${modelRecord.name}" 当前不可用`,
      503,
    );
  }

  if (provider === 'minimax-h3') {
    let prepared: MinimaxH3PreparedTask;
    try {
      prepared = await prepareMinimaxH3Task(body, h3Config(modelRecord));
    } catch (err) {
      throw toLocalVideoError(err);
    }

    const taskId = createShortTaskId();
    const now = Date.now();
    const task: LocalTaskEnvelopeV2 = {
      v: 2,
      provider,
      model: modelRecord.name,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      abandoned: false,
      prepared,
      effectiveParams: { ...prepared.effectiveParams, queue_limit: queueLimit() },
    };

    await saveTask(taskId, task);
    await touchTaskHeartbeat(taskId, now);

    try {
      const position = await enqueueTask(taskId, provider);
      if (position < 0) {
        await deleteTask(taskId);
        throw new LocalVideoRequestError(
          'LOCAL_VIDEO_QUEUE_FULL',
          `MiniMax-H3 队列已满 (${queueLimit()}/${queueLimit()})，请稍后再试`,
          429,
        );
      }
    } catch (err) {
      await deleteTask(taskId).catch(() => undefined);
      if (err instanceof LocalVideoRequestError) throw err;
      throw new LocalVideoRequestError(
        'LOCAL_VIDEO_QUEUE_UNAVAILABLE',
        `本地视频队列暂不可用: ${err instanceof Error ? err.message : String(err)}`,
        503,
      );
    }

    return {
      id: taskId,
      task_id: taskId,
      video_id: taskId,
      status: 'queued',
      provider_status: 'maas_queued',
      model: modelRecord.name,
      created: Math.floor(now / 1000),
      effective_params: { ...prepared.effectiveParams, queue_limit: queueLimit() },
    };
  }

  throw new LocalVideoRequestError(
    'LOCAL_VIDEO_PROVIDER_UNSUPPORTED',
    `不支持的本地视频 provider: ${provider}`,
    400,
  );
}

async function resolveTask(taskId: string): Promise<{
  task: LocalTaskEnvelope;
  modelRecord: any;
}> {
  const task = await loadTask(taskId);

  if (!task) {
    throw new LocalVideoRequestError(
      'LOCAL_VIDEO_TASK_NOT_FOUND',
      '本地视频任务不存在、已过期或任务 ID 无效',
      404,
    );
  }

  const modelRecord = await prisma.model.findUnique({
    where: { name: task.model },
  });

  if (!modelRecord) {
    throw new Error(`任务对应模型 "${task.model}" 不存在`);
  }

  if (providerOf(modelRecord) !== task.provider) {
    throw new Error(`任务 provider 与模型当前配置不一致: ${task.provider}`);
  }

  return { task, modelRecord };
}

export async function getLocalVideoTask(taskId: string, request?: any): Promise<any> {
  const resolved = await resolveTask(taskId);
  let { task } = resolved;
  const { modelRecord } = resolved;

  if (isV2Task(task)) {
    const now = Date.now();
    task.lastSeenAt = now;
    task.updatedAt = now;
    await touchTaskHeartbeat(taskId, now);
    if (task.abandoned && !['succeeded', 'failed'].includes(task.state)) {
      task.abandoned = false;
    }
    await saveTask(taskId, task);

    if (task.state === 'running' && task.nativeId) {
      task = await refreshV2FromProvider(taskId, task, modelRecord);
    }

    const result: any = {
      id: taskId,
      task_id: taskId,
      video_id: taskId,
      model: modelRecord.name,
      created: Math.floor(task.createdAt / 1000),
      effective_params: task.effectiveParams,
    };

    if (task.state === 'queued') {
      result.status = 'queued';
      result.provider_status = 'maas_queued';
      return result;
    }

    if (task.state === 'submitting') {
      result.status = 'processing';
      result.provider_status = 'maas_submitting';
      return result;
    }

    if (task.state === 'failed') {
      result.status = 'failed';
      result.provider_status = task.providerStatus || 'failed';
      result.error = task.error || '本地视频任务失败';
      return result;
    }

    if (task.state === 'succeeded') {
      result.status = 'succeeded';
      result.provider_status = task.providerStatus || 'completed';
      result.progress = 100;
      const url = signedContentUrl(request, taskId);
      result.video_url = url;
      result.url = url;
      result.download_url = url;
      return result;
    }

    result.status = 'processing';
    result.provider_status = task.providerStatus || 'processing';
    if (task.progress !== undefined) result.progress = task.progress;
    if (task.error) result.error = task.error;
    return result;
  }

  if (task.provider === 'minimax-h3') {
    const native = await getMinimaxH3Task(
      task.nativeId,
      h3Config(modelRecord),
    );

    const normalized = normalizeStatus(native.nativeStatus);

    const result: any = {
      id: taskId,
      task_id: taskId,
      video_id: taskId,
      status: normalized.status,
      provider_status: normalized.providerStatus,
      model: modelRecord.name,
      created: native.createdAt || Math.floor(Date.now() / 1000),
    };

    if (native.progress !== undefined) result.progress = native.progress;
    if (native.error) result.error = native.error;

    if (normalized.status === 'succeeded') {
      const url = signedContentUrl(request, taskId);
      result.video_url = url;
      result.url = url;
      result.download_url = url;
    }

    return result;
  }

  throw new Error(`不支持的本地视频 provider: ${task.provider}`);
}

export async function verifyLocalVideoContentSignature(
  taskId: string,
  expiresRaw: unknown,
  signatureRaw: unknown,
): Promise<boolean> {
  if (!isLocalVideoTaskId(taskId)) return false;

  const task = await loadTask(taskId);
  if (!task) return false;

  const expires = Number(expiresRaw);
  const signature = String(signatureRaw || '');

  if (!Number.isFinite(expires)) return false;
  if (expires < Math.floor(Date.now() / 1000)) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

  const expected = makeSignature(taskId, expires);

  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

export async function getLocalVideoContent(taskId: string) {
  const { task, modelRecord } = await resolveTask(taskId);

  if (task.provider === 'minimax-h3') {
    if (isV2Task(task)) {
      if (task.state !== 'succeeded' || !task.nativeId) {
        throw new LocalVideoRequestError(
          'LOCAL_VIDEO_NOT_READY',
          '本地视频任务尚未完成',
          409,
        );
      }
      return getMinimaxH3Content(task.nativeId, h3Config(modelRecord));
    }

    return getMinimaxH3Content(task.nativeId, h3Config(modelRecord));
  }

  throw new Error(`不支持的本地视频 provider: ${task.provider}`);
}

async function processRunningTask(taskId: string): Promise<void> {
  const loaded = await loadTask(taskId);
  if (!loaded || !isV2Task(loaded)) {
    await clearRunningIfMatches(taskId, WORKER_PROVIDER);
    return;
  }

  const task = loaded;
  const now = Date.now();

  if (['succeeded', 'failed'].includes(task.state)) {
    await clearRunningIfMatches(taskId, task.provider);
    return;
  }

  if (!task.nativeId) {
    if (task.state === 'submitting' && now - task.updatedAt > 120_000) {
      task.state = 'failed';
      task.error = 'MaaS 在提交 MiniMax-H3 任务时中断，无法确认后端任务 ID';
      task.updatedAt = now;
      await saveTask(taskId, task);
      await clearRunningIfMatches(taskId, task.provider);
    }
    return;
  }

  const modelRecord = await prisma.model.findUnique({ where: { name: task.model } });
  if (!modelRecord || providerOf(modelRecord) !== task.provider) {
    task.state = 'failed';
    task.error = `任务对应模型 "${task.model}" 不存在或 provider 已变化`;
    task.updatedAt = now;
    await saveTask(taskId, task);
    await clearRunningIfMatches(taskId, task.provider);
    return;
  }

  const native = await getMinimaxH3Task(task.nativeId, h3Config(modelRecord));
  const normalized = normalizeStatus(native.nativeStatus);
  const currentLastSeenAt = await taskLastSeenAt(taskId, task.lastSeenAt);
  task.lastSeenAt = Math.max(task.lastSeenAt, currentLastSeenAt);
  task.abandoned = Date.now() - currentLastSeenAt > orphanTimeoutMs();
  task.providerStatus = normalized.providerStatus;
  task.updatedAt = Date.now();
  if (native.progress !== undefined) task.progress = native.progress;
  if (native.error) task.error = native.error;

  if (normalized.status === 'succeeded') {
    if (task.abandoned) {
      await deleteMinimaxH3Task(task.nativeId, h3Config(modelRecord)).catch((err) => {
        console.warn('[LocalVideoWorker] 清理 abandoned H3 任务记录失败:', err?.message || err);
      });
      await deleteTask(taskId);
    } else {
      task.state = 'succeeded';
      task.progress = 100;
      await saveTask(taskId, task);
    }
    await clearRunningIfMatches(taskId, task.provider);
    return;
  }

  if (normalized.status === 'failed') {
    if (task.abandoned) {
      await deleteTask(taskId);
    } else {
      task.state = 'failed';
      task.error = native.error || `MiniMax-H3 任务失败 (${normalized.providerStatus})`;
      await saveTask(taskId, task);
    }
    await clearRunningIfMatches(taskId, task.provider);
    return;
  }

  task.state = 'running';
  await saveTask(taskId, task);
  await getRedis().expire(redisRunningKey(task.provider), runningKeyTtlSeconds());
}

async function dispatchNextQueuedTask(): Promise<void> {
  const queueKey = redisQueueKey(WORKER_PROVIDER);

  for (let i = 0; i < queueLimit(); i++) {
    const headTaskId = await getRedis().lindex(queueKey, 0);
    if (!headTaskId) return;

    const loaded = await loadTask(headTaskId);
    if (!loaded || !isV2Task(loaded) || loaded.provider !== WORKER_PROVIDER) {
      await getRedis().lpop(queueKey);
      continue;
    }

    let task = loaded;
    const now = Date.now();

    if (task.state !== 'queued') {
      await getRedis().lpop(queueKey);
      continue;
    }

    if (await isTaskOrphan(headTaskId, task.lastSeenAt)) {
      const removed = await removeQueuedTaskIfOrphan(headTaskId, task.provider);
      if (removed) continue;
    }

    if (!task.prepared) {
      await getRedis().lpop(queueKey);
      task.state = 'failed';
      task.error = 'MaaS 排队任务缺少已标准化的请求参数';
      task.updatedAt = now;
      await saveTask(headTaskId, task);
      continue;
    }

    const modelRecord = await prisma.model.findUnique({ where: { name: task.model } });
    if (!modelRecord || providerOf(modelRecord) !== task.provider || modelRecord.status !== 'online') {
      await getRedis().lpop(queueKey);
      task.state = 'failed';
      task.error = `模型 "${task.model}" 当前不可用或 provider 配置已变化`;
      task.updatedAt = now;
      await saveTask(headTaskId, task);
      continue;
    }

    // Keep the H3 backend at one active job. This also protects deployment
    // transitions where an older/external H3 job is still finishing.
    try {
      const activeCount = await getMinimaxH3ActiveTaskCount(h3Config(modelRecord));
      if (activeCount > 0) return;
    } catch (err) {
      console.warn(
        '[LocalVideoWorker] 无法确认 H3 是否空闲，本轮不提交新任务:',
        (err as Error).message,
      );
      return;
    }

    const popped = await getRedis().lpop(queueKey);
    if (popped !== headTaskId) {
      if (popped) {
        await getRedis().lpush(queueKey, popped);
      }
      return;
    }

    const latest = await loadTask(headTaskId);
    if (latest && isV2Task(latest) && latest.state === 'queued') {
      task = latest;
    }
    const latestLastSeenAt = await taskLastSeenAt(headTaskId, task.lastSeenAt);
    task.lastSeenAt = Math.max(task.lastSeenAt, latestLastSeenAt);

    if (!task.prepared) {
      task.state = 'failed';
      task.error = 'MaaS 排队任务缺少已标准化的请求参数';
      task.updatedAt = Date.now();
      await saveTask(headTaskId, task);
      return;
    }

    task.state = 'submitting';
    task.updatedAt = now;
    await saveTask(headTaskId, task);
    await getRedis().set(
      redisRunningKey(task.provider),
      headTaskId,
      'EX',
      runningKeyTtlSeconds(),
    );

    try {
      const created = await submitMinimaxH3PreparedTask(
        task.prepared,
        h3Config(modelRecord),
        true,
      );

      task.nativeId = created.nativeId;
      task.providerStatus = created.nativeStatus;
      task.state = 'running';
      task.updatedAt = Date.now();
      task.prepared = undefined;
      task.effectiveParams = { ...created.effectiveParams, queue_limit: queueLimit() };
      await saveTask(headTaskId, task);
      return;
    } catch (err) {
      const mapped = toLocalVideoError(err);
      task.state = 'failed';
      task.error = mapped.message;
      task.providerStatus = mapped.code;
      task.updatedAt = Date.now();
      await saveTask(headTaskId, task);
      await clearRunningIfMatches(headTaskId, task.provider);
      return;
    }
  }
}

async function workerTick(): Promise<void> {
  if (workerBusy || workerStopping) return;
  workerBusy = true;

  let lockToken: string | null = null;
  try {
    lockToken = await acquireWorkerLock(WORKER_PROVIDER);
    if (!lockToken) return;

    const runningTaskId = await getRedis().get(redisRunningKey(WORKER_PROVIDER));
    if (runningTaskId) {
      await processRunningTask(runningTaskId);
      return;
    }

    await dispatchNextQueuedTask();
  } catch (err) {
    console.error('[LocalVideoWorker] worker tick 失败:', err);
  } finally {
    if (lockToken) {
      await releaseWorkerLock(WORKER_PROVIDER, lockToken).catch(() => undefined);
    }
    workerBusy = false;
  }
}

async function sweepQueuedOrphans(): Promise<void> {
  if (sweepBusy || workerStopping) return;
  sweepBusy = true;

  try {
    const taskIds = await getRedis().lrange(redisQueueKey(WORKER_PROVIDER), 0, -1);

    for (const taskId of taskIds) {
      const loaded = await loadTask(taskId);
      if (!loaded || !isV2Task(loaded)) {
        await removeQueuedTask(taskId, WORKER_PROVIDER);
        continue;
      }

      if (loaded.state !== 'queued') {
        await removeQueuedTask(taskId, loaded.provider);
        continue;
      }

      if (await isTaskOrphan(taskId, loaded.lastSeenAt)) {
        const removed = await removeQueuedTaskIfOrphan(taskId, loaded.provider);
        if (removed) {
          console.log(`[LocalVideoWorker] 已回收失联排队任务: ${taskId}`);
        }
      }
    }
  } catch (err) {
    console.error('[LocalVideoWorker] orphan sweep 失败:', err);
  } finally {
    sweepBusy = false;
  }
}

export function startLocalVideoQueueWorker(): void {
  if (workerTimer || sweepTimer) return;

  workerStopping = false;
  console.log(
    `[LocalVideoWorker] 启动: queueLimit=${queueLimit()}, orphanTimeout=${Math.round(orphanTimeoutMs() / 1000)}s`,
  );

  void workerTick();
  void sweepQueuedOrphans();

  workerTimer = setInterval(() => {
    void workerTick();
  }, workerIntervalMs());

  sweepTimer = setInterval(() => {
    void sweepQueuedOrphans();
  }, sweepIntervalMs());
}

export async function stopLocalVideoQueueWorker(): Promise<void> {
  workerStopping = true;

  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }

  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  const deadline = Date.now() + 5000;
  while ((workerBusy || sweepBusy) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log('[LocalVideoWorker] 已停止领取新任务');
}

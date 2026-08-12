/**
 * Generic local-video provider layer.
 *
 * Add future local video backends here rather than expanding generate.ts.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import prisma from '../../config/database';
import {
  createMinimaxH3Task,
  getMinimaxH3Content,
  getMinimaxH3Task,
  MinimaxH3Config,
} from './minimax-h3';

type LocalVideoProvider = 'minimax-h3';

interface LocalTaskEnvelope {
  v: 1;
  provider: LocalVideoProvider;
  model: string;
  nativeId: string;
}

const TASK_PREFIX = 'lv1_';

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
    endpoint: cfg.endpoint,
    defaults: cfg.defaults || cfg.videoDefaults,
    limits: cfg.limits,
  };
}

function encodeTask(task: LocalTaskEnvelope): string {
  return TASK_PREFIX + Buffer.from(JSON.stringify(task), 'utf8').toString('base64url');
}

function decodeTask(taskId: string): LocalTaskEnvelope | null {
  if (!taskId.startsWith(TASK_PREFIX)) return null;

  try {
    const value = JSON.parse(
      Buffer.from(taskId.slice(TASK_PREFIX.length), 'base64url').toString('utf8')
    );

    if (
      value?.v === 1 &&
      value?.provider === 'minimax-h3' &&
      typeof value?.model === 'string' &&
      typeof value?.nativeId === 'string'
    ) {
      return value as LocalTaskEnvelope;
    }
  } catch {
    // Not a valid local-video task.
  }

  return null;
}

function normalizeStatus(nativeStatus: string): { status: string; providerStatus: string } {
  const value = String(nativeStatus || '').toLowerCase();

  if (['completed', 'succeeded', 'success', 'done', 'finished'].includes(value)) {
    return { status: 'succeeded', providerStatus: value };
  }

  if (['failed', 'error', 'cancelled', 'canceled'].includes(value)) {
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
    headers['x-forwarded-proto'] || request?.protocol || 'http'
  ).split(',')[0].trim();

  const host = String(
    headers['x-forwarded-host'] || headers.host || '127.0.0.1:3001'
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
  const ttl = Number.isFinite(parsedTtl) ? Math.max(60, Math.trunc(parsedTtl)) : 86400;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const signature = makeSignature(taskId, expires);

  return `${publicBase(request)}/v1/video/generations/${encodeURIComponent(taskId)}/content?expires=${expires}&signature=${signature}`;
}

export function supportsLocalVideoModel(modelRecord: any): boolean {
  return providerOf(modelRecord) !== null;
}

export function isLocalVideoTaskId(taskId: string): boolean {
  return decodeTask(taskId) !== null;
}

export async function createLocalVideoTask(modelRecord: any, body: any): Promise<any> {
  const provider = providerOf(modelRecord);
  if (!provider) {
    throw new Error(`本地视频模型 "${modelRecord?.name || '(unknown)'}" 未配置受支持的 videoProvider`);
  }

  if (modelRecord.status !== 'online') {
    throw new Error(`模型 "${modelRecord.name}" 当前不可用`);
  }

  if (provider === 'minimax-h3') {
    const created = await createMinimaxH3Task(body, h3Config(modelRecord));
    const taskId = encodeTask({
      v: 1,
      provider,
      model: modelRecord.name,
      nativeId: created.nativeId,
    });

    const normalized = normalizeStatus(created.nativeStatus);

    return {
      id: taskId,
      task_id: taskId,
      video_id: taskId,
      status: normalized.status,
      provider_status: normalized.providerStatus,
      model: modelRecord.name,
      created: created.createdAt || Math.floor(Date.now() / 1000),
      effective_params: created.effectiveParams,
    };
  }

  throw new Error(`不支持的本地视频 provider: ${provider}`);
}

async function resolveTask(taskId: string): Promise<{ task: LocalTaskEnvelope; modelRecord: any }> {
  const task = decodeTask(taskId);
  if (!task) throw new Error('不是有效的本地视频任务 ID');

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
  const { task, modelRecord } = await resolveTask(taskId);

  if (task.provider === 'minimax-h3') {
    const native = await getMinimaxH3Task(task.nativeId, h3Config(modelRecord));
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

export function verifyLocalVideoContentSignature(
  taskId: string,
  expiresRaw: unknown,
  signatureRaw: unknown,
): boolean {
  if (!decodeTask(taskId)) return false;

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
    return getMinimaxH3Content(task.nativeId, h3Config(modelRecord));
  }

  throw new Error(`不支持的本地视频 provider: ${task.provider}`);
}

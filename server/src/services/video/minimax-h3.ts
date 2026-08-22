/**
 * MiniMax-H3 adapter for the local SGLang Videos API.
 *
 * Current production runtime:
 * - Ref2VA only
 * - Uses endpointRef2VA / MINIMAX_H3_ENDPOINT_REF2VA
 * - T2VA / FL2VA automatic routing is disabled
 */

import prisma from '../../config/database';



async function resolveH3MaterialUri(uri: string): Promise<string> {
  const value = String(uri || '').trim();

  if (!value.toLowerCase().startsWith('asset://')) {
    return value;
  }

  const assetId = value.slice('asset://'.length).trim();

  if (!assetId) {
    throw new MinimaxH3RequestError('REFERENCE_ASSET_INVALID', 'MiniMax-H3 收到无效的 asset:// 素材地址', 400);
  }

  const asset = await prisma.asset.findUnique({
    where: { volcAssetId: assetId },
    select: {
      sourceUrl: true,
      assetType: true,
      volcStatus: true,
    },
  });

  if (!asset) {
    throw new MinimaxH3RequestError('REFERENCE_ASSET_NOT_FOUND', `MiniMax-H3 找不到素材: ${assetId}`, 400);
  }

  if (!asset.sourceUrl) {
    throw new MinimaxH3RequestError('REFERENCE_ASSET_URL_MISSING', `MiniMax-H3 素材 ${assetId} 没有可用的 sourceUrl`, 400);
  }

  return asset.sourceUrl;
}


export interface MinimaxH3Config {
  endpointRef2VA?: string;
  ref2vaEnabled?: boolean;
  defaults?: {
    fps?: number;
    resolution?: string;
    duration?: number;
    numInferenceSteps?: number;
    flowShift?: number;
    audioFlowShift?: number;
  };
  limits?: {
    maxDuration?: number;
    minDuration?: number;
    maxInferenceSteps?: number;
    minInferenceSteps?: number;
    mediaFetchTimeoutMs?: number;
    maxReferenceBytes?: number;
  };
}

export interface MinimaxH3CreatedTask {
  nativeId: string;
  nativeStatus: string;
  createdAt?: number;
  effectiveParams: Record<string, unknown>;
}

export class MinimaxH3RequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'MinimaxH3RequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type MinimaxH3MaterialType = 'image' | 'video' | 'audio';

export interface MinimaxH3PreparedTask {
  requestPayload: Record<string, any>;
  effectiveParams: Record<string, unknown>;
}

export interface MinimaxH3TaskStatus {
  nativeId: string;
  nativeStatus: string;
  createdAt?: number;
  progress?: number;
  error?: string;
}

function ref2vaEndpoint(config: MinimaxH3Config): string | null {
  const value =
    config.endpointRef2VA ||
    process.env.MINIMAX_H3_ENDPOINT_REF2VA;

  return value ? String(value).replace(/\/+$/, '') : null;
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}


function normalizeResolution(value: unknown): '720p' | '1080p' {
  const text = String(value || '720p').toLowerCase().trim();

  if (['1080p', '1080', 'fhd', 'fullhd'].includes(text)) {
    return '1080p';
  }

  return '720p';
}

function resolveSize(body: any, defaultResolution = '720p'): {
  width: number;
  height: number;
  ratio: string;
  resolution: '720p' | '1080p';
} {
  const direct = String(body.size || '').trim();
  const match = direct.match(/^(\d{2,5})[xX×](\d{2,5})$/);

  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);

    if (width % 32 !== 0 || height % 32 !== 0) {
      throw new Error('MiniMax-H3 width / height 必须是 32 的倍数');
    }

    return {
      width,
      height,
      ratio: String(body.ratio || `${width}:${height}`),
      resolution: width >= 1800 || height >= 1800 ? '1080p' : '720p',
    };
  }

  const ratio = String(body.ratio || body.aspect_ratio || '16:9');
  const resolution = normalizeResolution(
    body.resolution || defaultResolution,
  );

  const presets: Record<string, Record<string, [number, number]>> = {
    '720p': {
      '16:9': [1344, 768],
      '9:16': [768, 1344],
      '1:1': [1024, 1024],
    },
    '1080p': {
      '16:9': [1920, 1088],
      '9:16': [1088, 1920],
      '1:1': [1088, 1088],
    },
  };

  const resolutionPresets = presets[resolution];
  const selected = resolutionPresets[ratio];

  if (!selected) {
    throw new Error(`MiniMax-H3 暂不支持画幅 ${ratio}`);
  }

  return {
    width: selected[0],
    height: selected[1],
    ratio,
    resolution,
  };
}

function parseDataUri(uri: string): { mime: string; bytes: Buffer } {
  const match = uri.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);

  if (!match) {
    throw new MinimaxH3RequestError(
      'REFERENCE_DATA_URI_INVALID',
      '参考素材 data URI 格式无效',
      400,
    );
  }

  return {
    mime: match[1] || 'application/octet-stream',
    bytes: Buffer.from(match[2], 'base64'),
  };
}

function materialLabel(type: MinimaxH3MaterialType): string {
  if (type === 'image') return '参考图片';
  if (type === 'video') return '参考视频';
  return '参考音频';
}

function maxReferenceBytes(config: MinimaxH3Config): number {
  return Math.max(
    1,
    Math.trunc(numberOr(config.limits?.maxReferenceBytes, 25 * 1024 * 1024)),
  );
}

function mediaFetchTimeoutMs(config: MinimaxH3Config): number {
  return Math.max(
    1000,
    Math.trunc(numberOr(config.limits?.mediaFetchTimeoutMs, 30_000)),
  );
}

function declaredResponseSize(resp: Response): number | null {
  const contentRange = resp.headers.get('content-range') || '';
  const rangeMatch = contentRange.match(/\/(\d+)\s*$/);
  if (rangeMatch) {
    const total = Number(rangeMatch[1]);
    if (Number.isFinite(total)) return total;
  }

  const declared = Number(resp.headers.get('content-length') || 0);
  return Number.isFinite(declared) && declared > 0 ? declared : null;
}

function materialHttpError(
  type: MinimaxH3MaterialType,
  uri: string,
  status: number,
): MinimaxH3RequestError {
  const label = materialLabel(type);
  if (status === 404 || status === 410) {
    return new MinimaxH3RequestError(
      'REFERENCE_NOT_FOUND',
      `${label}已失效或不存在，请重新上传素材`,
      400,
    );
  }
  if (status === 401 || status === 403) {
    return new MinimaxH3RequestError(
      'REFERENCE_FORBIDDEN',
      `${label}无法访问或授权已失效，请重新上传素材`,
      400,
    );
  }
  return new MinimaxH3RequestError(
    'REFERENCE_UNREACHABLE',
    `${label}访问失败 (${status}): ${uri.slice(0, 240)}`,
    status >= 500 ? 503 : 400,
  );
}

async function fetchProbe(
  uri: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Accept: '*/*',
    };
    if (method === 'GET') {
      headers.Range = 'bytes=0-0';
    }

    return await fetch(uri, {
      method,
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new MinimaxH3RequestError(
        'REFERENCE_FETCH_TIMEOUT',
        '参考素材访问超时，请检查素材链接或重新上传',
        400,
      );
    }
    throw new MinimaxH3RequestError(
      'REFERENCE_UNREACHABLE',
      `参考素材无法访问: ${err?.message || err}`,
      400,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function probeMaterialUri(
  uri: string,
  type: MinimaxH3MaterialType,
  config: MinimaxH3Config,
): Promise<void> {
  const value = String(uri || '').trim();
  const label = materialLabel(type);
  const maxBytes = maxReferenceBytes(config);
  const timeoutMs = mediaFetchTimeoutMs(config);

  if (!value) {
    throw new MinimaxH3RequestError(
      'REFERENCE_INVALID',
      `${label}地址为空`,
      400,
    );
  }

  if (value.startsWith('data:')) {
    const parsed = parseDataUri(value);
    if (parsed.bytes.length > maxBytes) {
      throw new MinimaxH3RequestError(
        'REFERENCE_TOO_LARGE',
        `${label}超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`,
        400,
      );
    }
    return;
  }

  if (!/^https?:\/\//i.test(value)) {
    throw new MinimaxH3RequestError(
      'REFERENCE_SCHEME_UNSUPPORTED',
      `${label}仅支持 http(s) URL、data URI 或可解析的 asset:// 地址`,
      400,
    );
  }

  let head: Response | null = null;
  try {
    head = await fetchProbe(value, 'HEAD', timeoutMs);
    if (head.ok) {
      const declared = declaredResponseSize(head);
      if (declared !== null && declared > maxBytes) {
        throw new MinimaxH3RequestError(
          'REFERENCE_TOO_LARGE',
          `${label}超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`,
          400,
        );
      }
      return;
    }
  } finally {
    if (head?.body) {
      await head.body.cancel().catch(() => undefined);
    }
  }

  // Some temporary-file hosts reject HEAD. Confirm with a one-byte ranged GET
  // before deciding the material is invalid.
  let ranged: Response | null = null;
  try {
    ranged = await fetchProbe(value, 'GET', timeoutMs);
    if (!ranged.ok) {
      throw materialHttpError(type, value, ranged.status);
    }

    const declared = declaredResponseSize(ranged);
    if (declared !== null && declared > maxBytes) {
      throw new MinimaxH3RequestError(
        'REFERENCE_TOO_LARGE',
        `${label}超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`,
        400,
      );
    }
  } finally {
    if (ranged?.body) {
      await ranged.body.cancel().catch(() => undefined);
    }
  }
}

async function probePreparedMaterials(
  prepared: MinimaxH3PreparedTask,
  config: MinimaxH3Config,
): Promise<void> {
  const conditions = Array.isArray(prepared.requestPayload?.conditions)
    ? prepared.requestPayload.conditions
    : [];

  await Promise.all(conditions.map(async (condition: any) => {
    const type = String(condition?.type || '') as MinimaxH3MaterialType;
    if (!['image', 'video', 'audio'].includes(type)) {
      throw new MinimaxH3RequestError(
        'REFERENCE_TYPE_INVALID',
        `MiniMax-H3 收到不支持的参考素材类型: ${String(condition?.type || '')}`,
        400,
      );
    }
    await probeMaterialUri(String(condition?.uri || ''), type, config);
  }));
}

function validateDuration(
  body: any,
  config: MinimaxH3Config,
): number {
  const defaultDuration = numberOr(config.defaults?.duration, 4);
  const duration = numberOr(body.duration ?? body.seconds, defaultDuration);
  const minDuration = numberOr(config.limits?.minDuration, 1);
  const maxDuration = numberOr(config.limits?.maxDuration, 15);

  if (duration < minDuration || duration > maxDuration) {
    throw new MinimaxH3RequestError(
      'H3_DURATION_INVALID',
      `MiniMax-H3 duration 允许范围为 ${minDuration}~${maxDuration} 秒；收到 ${duration} 秒`,
      400,
    );
  }

  return duration;
}

export async function prepareMinimaxH3Task(
  body: any,
  config: MinimaxH3Config,
): Promise<MinimaxH3PreparedTask> {
  const prompt = String(body.prompt || '').trim();

  if (!prompt) {
    throw new MinimaxH3RequestError('H3_PROMPT_REQUIRED', 'MiniMax-H3 需要 prompt', 400);
  }

  const endpoint = ref2vaEndpoint(config);
  if (!config.ref2vaEnabled || !endpoint) {
    throw new MinimaxH3RequestError(
      'H3_REF2VA_DISABLED',
      'MiniMax-H3 Ref2VA 尚未启用，请配置 ref2vaEnabled=true 和 endpointRef2VA',
      503,
    );
  }

  const duration = validateDuration(body, config);
  const steps = Math.trunc(
    numberOr(
      body.num_inference_steps ?? body.numInferenceSteps ?? body.steps,
      numberOr(config.defaults?.numInferenceSteps, 50),
    ),
  );

  if (steps < 10 || steps > 50) {
    throw new MinimaxH3RequestError(
      'H3_STEPS_INVALID',
      `MiniMax-H3 Ref2VA num_inference_steps 允许范围为 10~50；收到 ${steps}`,
      400,
    );
  }

  const flowShift = numberOr(
    body.flow_shift ?? body.flowShift,
    numberOr(config.defaults?.flowShift, 12),
  );
  const audioFlowShift = numberOr(
    body.audio_flow_shift ?? body.audioFlowShift,
    numberOr(config.defaults?.audioFlowShift, 3.0),
  );
  let size: ReturnType<typeof resolveSize>;
  try {
    size = resolveSize(body, config.defaults?.resolution || '720p');
  } catch (err) {
    throw new MinimaxH3RequestError(
      'H3_SIZE_INVALID',
      err instanceof Error ? err.message : String(err),
      400,
    );
  }

  const normalizeList = (value: any): string[] => {
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim());
  };
  const unique = (items: string[]): string[] => [...new Set(items.filter(Boolean))];

  const rawImageRefs = unique([
    ...normalizeList(body.reference_images),
    ...normalizeList(body.images),
    ...normalizeList(body.image),
    ...normalizeList(body.first_frame),
    ...normalizeList(body.last_frame),
  ]);
  const rawVideoRefs = unique([
    ...normalizeList(body.reference_videos),
    ...normalizeList(body.videos),
  ]);
  const rawAudioRefs = unique([
    ...normalizeList(body.reference_audios),
    ...normalizeList(body.audios),
  ]);

  const resolveAll = async (
    refs: string[],
    type: MinimaxH3MaterialType,
  ): Promise<Array<{ type: MinimaxH3MaterialType; uri: string; role: 'reference' }>> => {
    const resolved = await Promise.all(refs.map(resolveH3MaterialUri));
    return resolved.map((uri) => ({ type, uri, role: 'reference' as const }));
  };

  const conditions = [
    ...(await resolveAll(rawImageRefs, 'image')),
    ...(await resolveAll(rawVideoRefs, 'video')),
    ...(await resolveAll(rawAudioRefs, 'audio')),
  ];

  if (conditions.length === 0) {
    throw new MinimaxH3RequestError(
      'H3_REFERENCE_REQUIRED',
      'MiniMax-H3 Ref2VA 至少需要一个参考图片、参考视频或参考音频',
      400,
    );
  }

  const seed =
    body.seed !== undefined && body.seed !== ''
      ? Math.trunc(Number(body.seed))
      : undefined;
  if (seed !== undefined && !Number.isFinite(seed)) {
    throw new MinimaxH3RequestError('H3_SEED_INVALID', 'MiniMax-H3 seed 必须为数字', 400);
  }

  const shortEdge = Math.min(size.width, size.height);
  const requestPayload: Record<string, any> = {
    task: 'ref2va',
    prompt,
    conditions,
    target: {
      short_edge: shortEdge,
      aspect_ratio: size.ratio,
      duration_seconds: duration,
    },
    n: 1,
    num_inference_steps: steps,
    flow_shift: flowShift,
    audio_flow_shift: audioFlowShift,
  };
  if (seed !== undefined) requestPayload.seed = seed;

  const prepared: MinimaxH3PreparedTask = {
    requestPayload,
    effectiveParams: {
      task: 'ref2va',
      width: size.width,
      height: size.height,
      ratio: size.ratio,
      resolution: size.resolution,
      duration,
      fps: 24,
      requested_fps:
        body.fps !== undefined && body.fps !== '' ? Number(body.fps) : undefined,
      short_edge: shortEdge,
      num_inference_steps: steps,
      flow_shift: flowShift,
      audio_flow_shift: audioFlowShift,
      image_references: rawImageRefs.length,
      video_references: rawVideoRefs.length,
      audio_references: rawAudioRefs.length,
      queue_limit: 10,
      seed,
    },
  };

  // First probe: reject expired/unreachable materials before a MaaS task is queued.
  await probePreparedMaterials(prepared, config);
  return prepared;
}

export async function submitMinimaxH3PreparedTask(
  prepared: MinimaxH3PreparedTask,
  config: MinimaxH3Config,
  revalidateMaterials = true,
): Promise<MinimaxH3CreatedTask> {
  const endpoint = ref2vaEndpoint(config);
  if (!config.ref2vaEnabled || !endpoint) {
    throw new MinimaxH3RequestError(
      'H3_REF2VA_DISABLED',
      'MiniMax-H3 Ref2VA 尚未启用，请配置 ref2vaEnabled=true 和 endpointRef2VA',
      503,
    );
  }

  // Second probe: temporary URLs may expire while a task waits in the MaaS queue.
  if (revalidateMaterials) {
    await probePreparedMaterials(prepared, config);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let resp: Response;

  try {
    resp = await fetch(`${endpoint}/v1/videos`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(prepared.requestPayload),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new MinimaxH3RequestError(
        'H3_SUBMIT_TIMEOUT',
        'MiniMax-H3 任务提交超时',
        503,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const responseText = await resp.text();
  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = { raw: responseText };
  }

  if (!resp.ok) {
    throw new MinimaxH3RequestError(
      'H3_CREATE_FAILED',
      `MiniMax-H3 Ref2VA 创建任务失败 (${resp.status}): ${responseText.slice(0, 1200)}`,
      resp.status >= 500 ? 503 : 400,
    );
  }

  if (!data?.id) {
    throw new MinimaxH3RequestError(
      'H3_TASK_ID_MISSING',
      `MiniMax-H3 Ref2VA 未返回任务 ID: ${responseText.slice(0, 1200)}`,
      502,
    );
  }

  return {
    nativeId: String(data.id),
    nativeStatus: String(data.status || 'queued'),
    createdAt: data.created_at,
    effectiveParams: prepared.effectiveParams,
  };
}

export async function createMinimaxH3Task(
  body: any,
  config: MinimaxH3Config,
): Promise<MinimaxH3CreatedTask> {
  const prepared = await prepareMinimaxH3Task(body, config);
  return submitMinimaxH3PreparedTask(prepared, config, false);
}

export async function getMinimaxH3ActiveTaskCount(
  config: MinimaxH3Config,
): Promise<number> {
  const endpoint = ref2vaEndpoint(config);
  if (!endpoint) {
    throw new MinimaxH3RequestError('H3_ENDPOINT_MISSING', 'MiniMax-H3 Ref2VA endpoint 未配置', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(`${endpoint}/v1/videos?limit=100`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data: any = await resp.json();
    const jobs = Array.isArray(data?.data) ? data.data : [];
    return jobs.filter((job: any) => {
      const status = String(job?.status || '').toLowerCase();
      return ['queued', 'pending', 'processing', 'running', 'in_progress', 'in-progress'].includes(status);
    }).length;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new MinimaxH3RequestError('H3_QUEUE_QUERY_TIMEOUT', 'MiniMax-H3 队列状态查询超时', 503);
    }
    throw new MinimaxH3RequestError(
      'H3_QUEUE_QUERY_FAILED',
      `MiniMax-H3 队列状态查询失败: ${err?.message || err}`,
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteMinimaxH3Task(
  nativeId: string,
  config: MinimaxH3Config,
): Promise<void> {
  const endpoint = ref2vaEndpoint(config);
  if (!endpoint) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(`${endpoint}/v1/videos/${encodeURIComponent(nativeId)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text();
      throw new Error(`MiniMax-H3 删除任务记录失败 (${resp.status}): ${text.slice(0, 600)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}


export async function getMinimaxH3Task(
  nativeId: string,
  config: MinimaxH3Config,
): Promise<MinimaxH3TaskStatus> {
  const endpoint = ref2vaEndpoint(config);

  if (!endpoint) {
    throw new Error('MiniMax-H3 Ref2VA endpoint 未配置');
  }

  const resp = await fetch(
    `${endpoint}/v1/videos/${encodeURIComponent(nativeId)}`,
    {
      headers: {
        Accept: 'application/json',
      },
    },
  );

  const text = await resp.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    if (
      resp.status === 404 &&
      String(data?.detail || '').toLowerCase().includes('video not found')
    ) {
      return {
        nativeId,
        nativeStatus: 'processing',
        progress: undefined,
        error: undefined,
      };
    }

    throw new Error(
      `MiniMax-H3 查询任务失败 (${resp.status}): ${text.slice(0, 1200)}`,
    );
  }

  return {
    nativeId,
    nativeStatus: String(
      data.status || 'processing',
    ),
    createdAt: data.created_at,
    progress:
      typeof data.progress === 'number'
        ? data.progress
        : undefined,
    error:
      data.error
        ? (
          typeof data.error === 'string'
            ? data.error
            : data.error.message ||
              JSON.stringify(data.error)
        )
        : undefined,
  };
}

export async function getMinimaxH3Content(
  nativeId: string,
  config: MinimaxH3Config,
): Promise<{
  status: number;
  contentType: string;
  contentLength?: string;
  body: Buffer;
}> {
  const endpoint = ref2vaEndpoint(config);

  if (!endpoint) {
    throw new Error('MiniMax-H3 Ref2VA endpoint 未配置');
  }

  const resp = await fetch(
    `${endpoint}/v1/videos/${encodeURIComponent(nativeId)}/content`,
    {
      headers: {
        Accept: 'video/mp4,application/octet-stream',
      },
    },
  );

  return {
    status: resp.status,
    contentType:
      resp.headers.get('content-type') ||
      'video/mp4',
    contentLength:
      resp.headers.get('content-length') ||
      undefined,
    body: Buffer.from(
      await resp.arrayBuffer(),
    ),
  };
}

/**
 * MiniMax-H3 adapter for vLLM-Omni Videos API.
 *
 * Runtime v2:
 * - FL2VA endpoint is active
 * - Ref2VA endpoint/config is reserved for future deployment
 * - AI Studio generation parameters are honored where H3 supports them
 */

export interface MinimaxH3Config {
  endpoint?: string;
  endpointFL2VA?: string;
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

export interface MinimaxH3TaskStatus {
  nativeId: string;
  nativeStatus: string;
  createdAt?: number;
  progress?: number;
  error?: string;
}

type H3TaskMode = 't2va' | 'fl2va' | 'ref2va';

function fl2vaEndpoint(config: MinimaxH3Config): string {
  return String(
    config.endpointFL2VA ||
    config.endpoint ||
    process.env.MINIMAX_H3_ENDPOINT_FL2VA ||
    process.env.MINIMAX_H3_ENDPOINT ||
    'http://127.0.0.1:8004'
  ).replace(/\/+$/, '');
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

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) return item.trim();
    }
  }

  return undefined;
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
    throw new Error('引用图片 data URI 格式无效');
  }

  return {
    mime: match[1] || 'image/jpeg',
    bytes: Buffer.from(match[2], 'base64'),
  };
}

async function fetchReferenceFile(
  value: string,
  config: MinimaxH3Config,
): Promise<{ blob: Blob; filename: string }> {
  const timeoutMs = numberOr(
    config.limits?.mediaFetchTimeoutMs,
    30_000,
  );

  const maxBytes = numberOr(
    config.limits?.maxReferenceBytes,
    25 * 1024 * 1024,
  );

  if (value.startsWith('data:')) {
    const parsed = parseDataUri(value);

    if (parsed.bytes.length > maxBytes) {
      throw new Error(
        `引用图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`,
      );
    }

    const ext = parsed.mime.includes('png')
      ? 'png'
      : parsed.mime.includes('webp')
        ? 'webp'
        : 'jpg';

    return {
      blob: new Blob(
        [new Uint8Array(parsed.bytes)],
        { type: parsed.mime },
      ),
      filename: `reference.${ext}`,
    };
  }

  if (!/^https?:\/\//i.test(value)) {
    throw new Error('引用图片仅支持 http(s) URL 或 data URI');
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  try {
    const resp = await fetch(
      value,
      { signal: controller.signal },
    );

    if (!resp.ok) {
      throw new Error(`引用图片下载失败 (${resp.status})`);
    }

    const declared = Number(
      resp.headers.get('content-length') || 0,
    );

    if (declared > maxBytes) {
      throw new Error(
        `引用图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`,
      );
    }

    const bytes = Buffer.from(
      await resp.arrayBuffer(),
    );

    if (bytes.length > maxBytes) {
      throw new Error(
        `引用图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`,
      );
    }

    const mime =
      resp.headers.get('content-type') ||
      'image/jpeg';

    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';

    return {
      blob: new Blob(
        [new Uint8Array(bytes)],
        { type: mime },
      ),
      filename: `reference.${ext}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractReferences(body: any) {
  const firstFrame =
    firstString(body.first_frame) ||
    firstString(body.image) ||
    firstString(body.images) ||
    firstString(body.reference_images);

  const lastFrame =
    firstString(body.last_frame);

  const videos =
    Array.isArray(body.videos)
      ? body.videos
      : (
        Array.isArray(body.reference_videos)
          ? body.reference_videos
          : []
      );

  const audios =
    Array.isArray(body.audios)
      ? body.audios
      : (
        Array.isArray(body.reference_audios)
          ? body.reference_audios
          : []
      );

  return {
    firstFrame,
    lastFrame,
    videos,
    audios,
  };
}

function detectTaskMode(body: any): H3TaskMode {
  const refs = extractReferences(body);

  if (
    refs.videos.length > 0 ||
    refs.audios.length > 0 ||
    (
      Array.isArray(body.reference_images) &&
      body.reference_images.length > 1
    )
  ) {
    return 'ref2va';
  }

  if (refs.firstFrame || refs.lastFrame) {
    return 'fl2va';
  }

  return 't2va';
}

function validateDuration(
  body: any,
  config: MinimaxH3Config,
): number {
  const defaultDuration = numberOr(
    config.defaults?.duration,
    4,
  );

  const duration = numberOr(
    body.duration ?? body.seconds,
    defaultDuration,
  );

  const minDuration = numberOr(
    config.limits?.minDuration,
    1,
  );

  const maxDuration = numberOr(
    config.limits?.maxDuration,
    15,
  );

  if (duration < minDuration || duration > maxDuration) {
    throw new Error(
      `MiniMax-H3 duration 允许范围为 ${minDuration}~${maxDuration} 秒；收到 ${duration} 秒`,
    );
  }

  return duration;
}

function validateSteps(
  body: any,
  config: MinimaxH3Config,
): number {
  const defaultSteps = Math.trunc(
    numberOr(
      config.defaults?.numInferenceSteps,
      30,
    ),
  );

  const steps = Math.trunc(
    numberOr(
      body.num_inference_steps ??
      body.numInferenceSteps ??
      body.steps,
      defaultSteps,
    ),
  );

  const minSteps = Math.trunc(
    numberOr(
      config.limits?.minInferenceSteps,
      10,
    ),
  );

  const maxSteps = Math.trunc(
    numberOr(
      config.limits?.maxInferenceSteps,
      40,
    ),
  );

  if (steps < minSteps || steps > maxSteps) {
    throw new Error(
      `MiniMax-H3 num_inference_steps 允许范围为 ${minSteps}~${maxSteps}；收到 ${steps}`,
    );
  }

  return steps;
}

export async function createMinimaxH3Task(
  body: any,
  config: MinimaxH3Config,
): Promise<MinimaxH3CreatedTask> {
  const prompt = String(body.prompt || '').trim();

  if (!prompt) {
    throw new Error('MiniMax-H3 需要 prompt');
  }

  const taskMode = detectTaskMode(body);
  const refs = extractReferences(body);

  if (taskMode === 'ref2va') {
    const endpoint = ref2vaEndpoint(config);

    if (!config.ref2vaEnabled || !endpoint) {
      throw new Error(
        'MiniMax-H3 Ref2VA 接口已预留，但当前服务器尚未部署/启用 Ref2VA endpoint',
      );
    }

    // Intentionally reserved until Ref2VA deployment is verified.
    throw new Error(
      'MiniMax-H3 Ref2VA endpoint 已配置，但当前 MaaS 版本仅预留路由接口，尚未启用 Ref2VA 请求体适配',
    );
  }

  if (refs.lastFrame) {
    throw new Error(
      '当前 MiniMax-H3 FL2VA 服务暂不开放尾帧控制',
    );
  }

  const duration =
    validateDuration(body, config);

  const fps = Math.trunc(
    numberOr(
      body.fps,
      numberOr(config.defaults?.fps, 24),
    ),
  );

  // Current H3 output pipeline is fixed at 24fps.
  if (fps !== 24) {
    throw new Error(
      `当前 MiniMax-H3 部署仅支持 24 FPS；收到 ${fps}`,
    );
  }

  const steps =
    validateSteps(body, config);

  const flowShift = numberOr(
    body.flow_shift ?? body.flowShift,
    numberOr(config.defaults?.flowShift, 12),
  );

  const audioFlowShift = numberOr(
    body.audio_flow_shift ?? body.audioFlowShift,
    numberOr(config.defaults?.audioFlowShift, 3.0),
  );

  const size = resolveSize(
    body,
    config.defaults?.resolution || '720p',
  );

  const form = new FormData();

  form.append('prompt', prompt);
  form.append('width', String(size.width));
  form.append('height', String(size.height));
  form.append('fps', String(fps));
  form.append(
    'num_inference_steps',
    String(steps),
  );
  form.append(
    'flow_shift',
    String(flowShift),
  );

  if (
    body.seed !== undefined &&
    body.seed !== ''
  ) {
    const seed = Number(body.seed);

    if (!Number.isFinite(seed)) {
      throw new Error('MiniMax-H3 seed 必须为数字');
    }

    form.append(
      'seed',
      String(Math.trunc(seed)),
    );
  }

  const extraParams: Record<string, unknown> = {
    task: taskMode,
    duration,
    audio_flow_shift: audioFlowShift,
  };

  if (refs.firstFrame) {
    const first = await fetchReferenceFile(
      refs.firstFrame,
      config,
    );

    form.append(
      'input_reference',
      first.blob,
      first.filename,
    );
  }

  form.append(
    'extra_params',
    JSON.stringify(extraParams),
  );

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    60_000,
  );

  let resp: Response;

  try {
    resp = await fetch(
      `${fl2vaEndpoint(config)}/v1/videos`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
        },
        body: form,
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(
      `MiniMax-H3 创建任务失败 (${resp.status}): ${text.slice(0, 1200)}`,
    );
  }

  if (!data?.id) {
    throw new Error(
      `MiniMax-H3 未返回任务 ID: ${text.slice(0, 1200)}`,
    );
  }

  return {
    nativeId: String(data.id),
    nativeStatus: String(
      data.status || 'queued',
    ),
    createdAt: data.created_at,
    effectiveParams: {
      task: taskMode,
      width: size.width,
      height: size.height,
      ratio: size.ratio,
      resolution: size.resolution,
      duration,
      fps,
      num_inference_steps: steps,
      flow_shift: flowShift,
      audio_flow_shift: audioFlowShift,
      seed:
        body.seed !== undefined &&
        body.seed !== ''
          ? Math.trunc(Number(body.seed))
          : undefined,
    },
  };
}

export async function getMinimaxH3Task(
  nativeId: string,
  config: MinimaxH3Config,
): Promise<MinimaxH3TaskStatus> {
  const resp = await fetch(
    `${fl2vaEndpoint(config)}/v1/videos/${encodeURIComponent(nativeId)}`,
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
  const resp = await fetch(
    `${fl2vaEndpoint(config)}/v1/videos/${encodeURIComponent(nativeId)}/content`,
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

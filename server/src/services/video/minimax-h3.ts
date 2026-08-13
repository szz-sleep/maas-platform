/**
 * MiniMax-H3 adapter for vLLM-Omni Videos API.
 *
 * Target deployment:
 *   - vLLM-Omni: http://127.0.0.1:8004
 *   - MiniMax-H3 FL2VA partition
 *   - async POST /v1/videos
 *
 * Keep model-specific protocol details here instead of in Fastify routes.
 */

export interface MinimaxH3Config {
  endpoint?: string;
  defaults?: {
    fps?: number;
    numInferenceSteps?: number;
    flowShift?: number;
    audioFlowShift?: number;
  };
  limits?: {
    maxDuration?: number;
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

function endpointOf(config: MinimaxH3Config): string {
  return String(
    config.endpoint ||
    process.env.MINIMAX_H3_ENDPOINT ||
    'http://127.0.0.1:8004'
  ).replace(/\/+$/, '');
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

function resolveSize(body: any): { width: number; height: number; ratio: string } {
  const direct = String(body.size || '').trim();
  const match = direct.match(/^(\d{2,5})[xX×](\d{2,5})$/);
  if (match) {
    return {
      width: Number(match[1]),
      height: Number(match[2]),
      ratio: String(body.ratio || `${match[1]}:${match[2]}`),
    };
  }

  // H3 tested deployment presets.
  const ratio = String(body.ratio || '16:9');
  const presets: Record<string, [number, number]> = {
    '16:9': [1344, 768],
    '9:16': [768, 1344],
    '1:1': [1024, 1024],
  };
  const selected = presets[ratio] || presets['16:9'];
  return {
    width: selected[0],
    height: selected[1],
    ratio: presets[ratio] ? ratio : '16:9',
  };
}

function parseDataUri(uri: string): { mime: string; bytes: Buffer } {
  const match = uri.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (!match) throw new Error('引用图片 data URI 格式无效');
  return {
    mime: match[1] || 'image/jpeg',
    bytes: Buffer.from(match[2], 'base64'),
  };
}

async function fetchReferenceFile(
  value: string,
  config: MinimaxH3Config,
): Promise<{ blob: Blob; filename: string }> {
  const timeoutMs = numberOr(config.limits?.mediaFetchTimeoutMs, 30_000);
  const maxBytes = numberOr(config.limits?.maxReferenceBytes, 25 * 1024 * 1024);

  if (value.startsWith('data:')) {
    const parsed = parseDataUri(value);
    if (parsed.bytes.length > maxBytes) {
      throw new Error(`引用图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    }
    const ext = parsed.mime.includes('png') ? 'png'
      : parsed.mime.includes('webp') ? 'webp'
      : 'jpg';
    return {
      blob: new Blob([new Uint8Array(parsed.bytes)], { type: parsed.mime }),
      filename: `reference.${ext}`,
    };
  }

  if (!/^https?:\/\//i.test(value)) {
    throw new Error('引用图片仅支持 http(s) URL 或 data URI');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(value, { signal: controller.signal });
    if (!resp.ok) throw new Error(`引用图片下载失败 (${resp.status})`);

    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      throw new Error(`引用图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    }

    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`引用图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    }

    const mime = resp.headers.get('content-type') || 'image/jpeg';
    const ext = mime.includes('png') ? 'png'
      : mime.includes('webp') ? 'webp'
      : 'jpg';

    return {
      blob: new Blob([new Uint8Array(bytes)], { type: mime }),
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

  const lastFrame = firstString(body.last_frame);

  const videos = Array.isArray(body.videos)
    ? body.videos
    : (Array.isArray(body.reference_videos) ? body.reference_videos : []);

  const audios = Array.isArray(body.audios)
    ? body.audios
    : (Array.isArray(body.reference_audios) ? body.reference_audios : []);

  return { firstFrame, lastFrame, videos, audios };
}

export async function createMinimaxH3Task(
  body: any,
  config: MinimaxH3Config,
): Promise<MinimaxH3CreatedTask> {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw new Error('MiniMax-H3 需要 prompt');

  const { firstFrame, lastFrame, videos, audios } = extractReferences(body);

  if (lastFrame) {
    throw new Error('当前 MiniMax-H3 FL2VA 服务暂不开放尾帧控制');
  }

  // Current service loads only FL2VA. Ref2VA inputs must not be silently degraded.
  if (videos.length > 0) {
    throw new Error('当前 MiniMax-H3 服务只加载 FL2VA，暂不支持参考视频（Ref2VA）');
  }
  if (audios.length > 0) {
    throw new Error('当前 MiniMax-H3 服务只加载 FL2VA，暂不支持参考音频（Ref2VA）');
  }

  const maxDuration = numberOr(config.limits?.maxDuration, 8);
  const duration = numberOr(body.duration ?? body.seconds, 4);
  if (duration <= 0) throw new Error('duration 必须大于 0');
  if (duration > maxDuration) {
    throw new Error(`当前 MiniMax-H3 部署最大允许 ${maxDuration} 秒；收到 ${duration} 秒`);
  }

  const fps = Math.trunc(numberOr(config.defaults?.fps, 24));
  const steps = Math.trunc(numberOr(config.defaults?.numInferenceSteps, 30));
  const flowShift = numberOr(config.defaults?.flowShift, 12);
  const audioFlowShift = numberOr(config.defaults?.audioFlowShift, 3.0);
  const size = resolveSize(body);

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(size.width));
  form.append('height', String(size.height));
  form.append('fps', String(fps));
  form.append('num_inference_steps', String(steps));
  form.append('flow_shift', String(flowShift));

  if (body.seed !== undefined && body.seed !== '') {
    const seed = Number(body.seed);
    if (Number.isFinite(seed)) form.append('seed', String(Math.trunc(seed)));
  }

  const extraParams: Record<string, unknown> = {
    task: firstFrame ? 'fl2va' : 't2va',
    duration,
    audio_flow_shift: audioFlowShift,
  };

  // Current FL2VA serving path: verified first-frame image input.
  if (firstFrame) {
    const first = await fetchReferenceFile(firstFrame, config);
    form.append('input_reference', first.blob, first.filename);
  }

  form.append('extra_params', JSON.stringify(extraParams));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let resp: Response;
  try {
    resp = await fetch(`${endpointOf(config)}/v1/videos`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!resp.ok) {
    throw new Error(`MiniMax-H3 创建任务失败 (${resp.status}): ${text.slice(0, 1200)}`);
  }
  if (!data?.id) {
    throw new Error(`MiniMax-H3 未返回任务 ID: ${text.slice(0, 1200)}`);
  }

  return {
    nativeId: String(data.id),
    nativeStatus: String(data.status || 'queued'),
    createdAt: data.created_at,
    effectiveParams: {
      task: extraParams.task,
      width: size.width,
      height: size.height,
      ratio: size.ratio,
      duration,
      fps,
      num_inference_steps: steps,
      flow_shift: flowShift,
      audio_flow_shift: audioFlowShift,
    },
  };
}

export async function getMinimaxH3Task(
  nativeId: string,
  config: MinimaxH3Config,
): Promise<MinimaxH3TaskStatus> {
  const resp = await fetch(`${endpointOf(config)}/v1/videos/${encodeURIComponent(nativeId)}`, {
    headers: { Accept: 'application/json' },
  });

  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!resp.ok) {
    throw new Error(`MiniMax-H3 查询任务失败 (${resp.status}): ${text.slice(0, 1200)}`);
  }

  return {
    nativeId,
    nativeStatus: String(data.status || 'processing'),
    createdAt: data.created_at,
    progress: typeof data.progress === 'number' ? data.progress : undefined,
    error: data.error
      ? (typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error))
      : undefined,
  };
}

export async function getMinimaxH3Content(
  nativeId: string,
  config: MinimaxH3Config,
): Promise<{ status: number; contentType: string; contentLength?: string; body: Buffer }> {
  const resp = await fetch(`${endpointOf(config)}/v1/videos/${encodeURIComponent(nativeId)}/content`, {
    headers: { Accept: 'video/mp4,application/octet-stream' },
  });

  return {
    status: resp.status,
    contentType: resp.headers.get('content-type') || 'video/mp4',
    contentLength: resp.headers.get('content-length') || undefined,
    body: Buffer.from(await resp.arrayBuffer()),
  };
}

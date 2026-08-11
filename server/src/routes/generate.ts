/**
 * 模型调用路由 — 统一网关
 *
 * 支持的模型类型（从 Model 表动态读取 source + modelType）：
 *   volcano + video   → 视频生成（Seedance）→ /contents/generations/tasks (异步)
 *   volcano + image   → 图片生成（Seedream）→ /images/generations (同步)
 *   volcano + chat    → 理解类（Seed 2.1 Pro）→ /responses
 *   volcano + audio   → 音频理解 → /responses
 *   local   + chat    → 自部署LLM（OpenAI兼容格式）
 *   local   + image   → 自部署图片模型（OpenAI兼容格式）
 *
 * 鉴权：API Key（用户方鉴权）+ 系统配额扣减
 * 模型配置全部从 Model 表动态读取，无硬编码
 */

import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { apiKeyAuth } from '../middleware/auth';
import { generateSchema } from '../utils/validators';
import { sha256 } from '../utils/apiKey';
import { loadApiKey } from '../services/volcano';

/**
 * 计费计算器 — 根据模型类型和实际用量算费
 */
function calcCost(model: any, inputTokens?: number, outputTokens?: number, durationSeconds?: number): number {
  const per1mIn = Number(model.per1mInputTokens || 0);
  const per1mOut = Number(model.per1mOutputTokens || 0);
  if ((per1mIn > 0 || per1mOut > 0) && inputTokens !== undefined) {
    return Number((((inputTokens || 0) / 1_000_000) * per1mIn + ((outputTokens || 0) / 1_000_000) * per1mOut).toFixed(6));
  }
  const perSec = Number(model.unitCostPerSecond || 0);
  if (perSec > 0 && durationSeconds) {
    return Number((durationSeconds * perSec).toFixed(6));
  }
  return Number(model.unitCost || 0.1);
}

const VOLCANO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

export default async function generateRoutes(app: FastifyInstance) {
  // ───── 统一生成入口 ─────
  app.post('/api/v1/generate', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || '参数错误' },
      });
    }

    const { model: modelName, prompt, ...params } = parsed.data;
    const startTime = Date.now();

    // 查找模型记录
    const modelRecord = await prisma.model.findUnique({ where: { name: modelName } });
    if (!modelRecord) {
      return reply.status(404).send({ success: false, error: { code: 'MODEL_NOT_FOUND', message: `模型 "${modelName}" 不存在` } });
    }
    if (modelRecord.status !== 'online') {
      return reply.status(503).send({ success: false, error: { code: 'MODEL_OFFLINE', message: `模型 "${modelName}" 当前不可用` } });
    }

    try {
      let result: any;
      const { source, modelType, volcanoModelId, volcanoEndpoint, unitCost } = modelRecord;

      if (source === 'volcano') {
        result = await callVolcano(modelType, volcanoModelId, volcanoEndpoint, prompt, params);
      } else if (source === 'local') {
        result = await callLocal(modelRecord, prompt, params);
      } else {
        throw new Error(`不支持的模型来源: ${source}`);
      }

      // 计算用量
      const duration = Date.now() - startTime;
      const usage = result.usage || {};
      const tokensInput = usage.input_tokens || 0;
      const tokensOutput = usage.output_tokens || 0;
      const videoDuration = params.duration || 0; // 视频生成秒数
      const cost = Number((result.cost || calcCost(modelRecord, tokensInput, tokensOutput, videoDuration)).toFixed(6));

      // 扣减配额
      await prisma.apiKey.update({
        where: { id: request.apiKeyId },
        data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
      });

      // 记录调用日志
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId,
          userId: request.apiKeyUserId,
          modelId: modelRecord.id,
          promptHash: sha256(prompt),
          responseHash: sha256(JSON.stringify(result)),
          tokensInput,
          tokensOutput,
          durationMs: duration,
          cost,
          status: 'success',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] || null,
        },
      });

      return { success: true, data: result, usage: { quotaDeducted: cost, durationMs: duration } };
    } catch (err) {
      const duration = Date.now() - startTime;
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId,
          userId: request.apiKeyUserId,
          modelId: modelRecord.id,
          promptHash: sha256(prompt),
          durationMs: duration,
          status: 'failed',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] || null,
        },
      });
      return reply.status(500).send({
        success: false,
        error: { code: 'GENERATION_FAILED', message: (err as Error).message },
        usage: { quotaDeducted: 0 },
      });
    }
  });

  // ── 轮询异步任务状态 ──
  app.get('/api/v1/tasks/:taskId', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      const apiKey = await loadApiKey();
      const resp = await fetch(`${VOLCANO_BASE}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = (await resp.json()) as any;
      return { success: true, data: { taskId, status: data.status, result: data.content, usage: data.usage, error: data.error } };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'QUERY_FAILED', message: (err as Error).message } });
    }
  });

  // ── 视频生成（OpenAI 兼容异步接口）─
  // POST /v1/video/generations     → 立即返回 task_id
  // GET  /v1/video/generations/:id → 查询任务状态
  // 解决 Cloudflare 100 秒超时问题：避免 MaaS 同步等火山引擎结果
  app.post('/v1/video/generations', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    try {
      const apiKey = await loadApiKey();
      const body = request.body as any;

      // 选择火山引擎视频模型（默认 Seedance 2.0）
      const volcanoModel = body.model;
      if (!volcanoModel) {
        return reply.status(400).send({ success: false, error: { code: 'MODEL_NOT_FOUND', message: '请指定视频模型' } });
      }

      // 构建火山引擎请求体
      const content: any[] = [{ type: 'text', text: body.prompt || '' }];

      // 首帧/尾帧：Seedance 正确格式是 image_url + role: first_frame / last_frame
      if (body.first_frame) {
        content.push({ type: 'image_url', image_url: { url: body.first_frame }, role: 'first_frame' });
      }
      if (body.last_frame) {
        content.push({ type: 'image_url', image_url: { url: body.last_frame }, role: 'last_frame' });
      }

      if (body.image) {
        content.push({ type: 'image_url', image_url: { url: body.image }, role: 'reference_image' });
      }
      if (Array.isArray(body.images)) {
        for (const img of body.images) {
          content.push({ type: 'image_url', image_url: { url: img }, role: 'reference_image' });
        }
      }
      if (Array.isArray(body.reference_images)) {
        for (const img of body.reference_images) {
          content.push({ type: 'image_url', image_url: { url: img }, role: 'reference_image' });
        }
      }
      // 视频参考：兼容 videos 与 reference_videos 两种字段名
      const refVids = Array.isArray(body.videos) ? body.videos : (Array.isArray(body.reference_videos) ? body.reference_videos : []);
      for (const vid of refVids) {
        content.push({ type: 'video_url', video_url: { url: vid }, role: 'reference_video' });
      }
      // 音频参考（用于音色参考）：兼容 audios 与 reference_audios 两种字段名
      const refAuds = Array.isArray(body.audios) ? body.audios : (Array.isArray(body.reference_audios) ? body.reference_audios : []);
      for (const aud of refAuds) {
        content.push({ type: 'audio_url', audio_url: { url: aud }, role: 'reference_audio' });
      }

      const volcanoBody: any = {
        model: volcanoModel,
        content,
        duration: body.duration || 5,
        ratio: body.ratio || '16:9',
        watermark: false,
      };
      if (body.resolution) volcanoBody.resolution = body.resolution;
      if (body.generate_audio) volcanoBody.generate_audio = true;
      if (body.return_last_frame) volcanoBody.return_last_frame = true;
      if (body.service_tier) volcanoBody.service_tier = body.service_tier;
      if (body.seed !== undefined && body.seed !== '') volcanoBody.seed = parseInt(body.seed);

      // 调火山引擎创建任务
      const resp = await fetch(`${VOLCANO_BASE}/contents/generations/tasks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(volcanoBody),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return reply.status(resp.status).send({ error: { message: `视频生成请求失败 (${resp.status}): ${errText}` } });
      }

      const createData = await resp.json() as any;
      const taskId = createData.id;
      if (!taskId) {
        return reply.status(500).send({ error: { message: `任务创建失败: ${JSON.stringify(createData)}` } });
      }

      // ✅ 立即返回 task_id，不同步等待
      // 返回格式兼容 OpenAI Video API（带 task_id）
      return reply.status(200).send({
        id: taskId,
        task_id: taskId,
        status: 'processing',
        model: volcanoModel,
        created: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      return reply.status(500).send({ error: { message: (err as Error).message } });
    }
  });

  // 查询视频任务状态（AI Studio 轮询用）
  app.get('/v1/video/generations/:taskId', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    try {
      const apiKey = await loadApiKey();
      const { taskId } = request.params as { taskId: string };

      const resp = await fetch(`${VOLCANO_BASE}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const taskData = await resp.json() as any;

      // 转换格式为 AI Studio 能识别的形式
      const status = taskData.status || 'processing';
      const result: any = {
        id: taskId,
        task_id: taskId,
        status,
        created: Math.floor(Date.now() / 1000),
      };

      if (status === 'succeeded') {
        result.video_url = taskData.content?.video?.url || taskData.content?.video_url;
        result.last_frame_url = taskData.content?.last_frame_image?.url;
        result.usage = taskData.usage;
      }

      if (status === 'failed') {
        result.error = taskData.error?.message || JSON.stringify(taskData.error || taskData);
      }

      return reply.status(200).send(result);
    } catch (err) {
      return reply.status(500).send({ error: { message: (err as Error).message } });
    }
  });
}

// ── 火山引擎统一调用（根据 modelType 路由到不同端点）──
async function callVolcano(modelType: string, volcanoModelId: string | null, endpoint: string | null, prompt: string, params: any): Promise<any> {
  const apiKey = await loadApiKey();
  const volcanoModel = volcanoModelId;
  if (!volcanoModel) {
    throw new Error(`模型 ${volcanoModelId || '(空)'} 未关联火山引擎模型ID`);
  }

  switch (modelType) {
    case 'video': return callVolcanoVideo(apiKey, volcanoModel, prompt, params);
    case 'image': return callVolcanoImage(apiKey, volcanoModel, prompt, params);
    case 'chat':
    case 'audio':
      return callVolcanoChat(apiKey, volcanoModel, prompt, params);
    default:
      throw new Error(`不支持的火山引擎模型类型: ${modelType}`);
  }
}

// ── 自部署模型调用（OpenAI 兼容格式）──
async function callLocal(modelRecord: any, prompt: string, params: any): Promise<any> {
  const baseUrl = modelRecord.config?.endpoint || 'http://localhost:11434/v1';

  if (modelRecord.modelType === 'chat') {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelRecord.name,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: params.max_tokens || 1024,
        temperature: params.temperature,
        stream: false,
      }),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(`自部署模型调用失败 (${resp.status}): ${JSON.stringify(errData)}`);
    }
    const data = await resp.json() as any;
    return {
      response: data.choices?.[0]?.message?.content || JSON.stringify(data),
      usage: data.usage || {},
      request_id: data.id,
    };
  }

  if (modelRecord.modelType === 'image') {
    const resp = await fetch(`${baseUrl}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...params }),
    });
    if (!resp.ok) throw new Error(`自部署图片生成失败 (${resp.status})`);
    const data = await resp.json() as any;
    return { images: data.images?.map((img: string) => ({ url: img })) || [], request_id: crypto.randomUUID() };
  }

  throw new Error(`不支持的自部署模型类型: ${modelRecord.modelType}`);
}

// ===== 视频生成（Seedance 2.0）===================
async function callVolcanoVideo(apiKey: string, volcanoModel: string, prompt: string, params: any): Promise<any> {
  const content: any[] = [{ type: 'text', text: prompt }];

  // 首帧/尾帧：Seedance 用 image_url + role: first_frame / last_frame
  if (params.first_frame) {
    content.push({ type: 'image_url', image_url: { url: params.first_frame }, role: 'first_frame' });
  }
  if (params.last_frame) {
    content.push({ type: 'image_url', image_url: { url: params.last_frame }, role: 'last_frame' });
  }

  for (const img of params.images || []) {
    content.push({ type: 'image_url', image_url: { url: img }, role: 'reference_image' });
  }
  for (const vid of params.videos || []) {
    content.push({ type: 'video_url', video_url: { url: vid }, role: 'reference_video' });
  }
  for (const aud of params.audios || []) {
    content.push({ type: 'audio_url', audio_url: { url: aud }, role: 'reference_audio' });
  }

  const body: any = {
    model: volcanoModel,
    content,
    duration: params.duration || 5,
    ratio: params.ratio || '16:9',
    watermark: false,
  };
  if (params.resolution) body.resolution = params.resolution;
  if (params.generate_audio) body.generate_audio = true;
  if (params.return_last_frame) body.return_last_frame = true;
  if (params.service_tier) body.service_tier = params.service_tier;

  const resp = await fetch(`${VOLCANO_BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`视频生成请求失败 (${resp.status}): ${errText}`);
  }

  const createData = await resp.json() as any;
  const taskId = createData.id;
  if (!taskId) throw new Error(`任务创建失败: ${JSON.stringify(createData)}`);

  // ✅ 异步模式：立即返回 task_id，不阻塞等待
  // 调用方通过 GET /api/v1/tasks/:taskId 或 GET /v1/video/generations/:taskId 轮询状态
  return { taskId, status: 'processing', message: '任务已创建，使用 GET /v1/video/generations/' + taskId + ' 查询进度' };
}

// ===== 图片生成（Seedream）=======================
async function callVolcanoImage(apiKey: string, volcanoModel: string, prompt: string, params: any): Promise<any> {
  const body: any = {
    model: volcanoModel,
    prompt,
    n: params.n || 1,
    size: params.size || '1024x1024',
    response_format: params.response_format || 'url',
    output_format: params.output_format || 'png',
    watermark: false,
  };

  const resp = await fetch(`${VOLCANO_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await resp.json() as any;
  if (!resp.ok) {
    throw new Error(`图片生成失败 (${resp.status}): ${JSON.stringify(data)}`);
  }
  return { images: data.data, request_id: data.id };
}

// ===== 理解类（视频/图片/文档/音频）===============
async function callVolcanoChat(apiKey: string, volcanoModel: string, prompt: string, params: any): Promise<any> {
  const content: any[] = [{ type: 'input_text', text: prompt }];

  for (const img of params.images || []) {
    content.push({ type: 'input_image', image_url: img });
  }
  for (const fileId of params.file_ids || []) {
    content.push({ type: 'input_file', file_id: fileId });
  }
  for (const audio of params.audios || []) {
    content.push({ type: 'input_audio', audio_url: audio });
  }

  const body: any = { model: volcanoModel, input: content, stream: false };
  if (params.max_tokens) body.max_output_tokens = params.max_tokens;
  if (params.temperature) body.temperature = params.temperature;

  const resp = await fetch(`${VOLCANO_BASE}/responses`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await resp.json() as any;
  if (!resp.ok) {
    throw new Error(`响应失败 (${resp.status}): ${JSON.stringify(data)}`);
  }
  return { response: data.output_text, request_id: data.id, usage: data.usage };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
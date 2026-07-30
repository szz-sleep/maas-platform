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
      const tokensInput = usage.input_tokens || prompt.length;
      const tokensOutput = usage.output_tokens || JSON.stringify(result).length;
      const cost = Number((result.cost || Number(unitCost) || 0.1).toFixed(4));

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
}

// ── 火山引擎统一调用（根据 modelType 路由到不同端点）──
async function callVolcano(modelType: string, volcanoModelId: string | null, endpoint: string | null, prompt: string, params: any): Promise<any> {
  const apiKey = await loadApiKey();
  const volcanoModel = volcanoModelId || 'doubao-seed-2-1-pro-260628';

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

  // 轮询等待（最多10分钟）
  const taskUrl = `${VOLCANO_BASE}/contents/generations/tasks/${taskId}`;
  let waited = 0;

  while (waited < 600000) {
    await sleep(10000);
    waited += 10000;

    const taskResp = await fetch(taskUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const taskData = await taskResp.json() as any;

    if (taskData.status === 'succeeded') {
      return {
        taskId,
        status: 'succeeded',
        video_url: taskData.content?.video?.url || taskData.content?.video_url,
        last_frame: taskData.content?.last_frame_image?.url,
        usage: taskData.usage,
      };
    }
    if (taskData.status === 'failed') {
      throw new Error(`任务失败: ${JSON.stringify(taskData.error || taskData)}`);
    }
  }

  return { taskId, status: 'processing', message: '任务处理中，可使用 /api/v1/tasks/' + taskId + ' 查询' };
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
/**
 * OpenAI 兼容接口
 *
 * 让用户拿到平台的 API Key 后，可以直接用 OpenAI SDK 调用：
 *   import OpenAI from 'openai'
 *   const client = new OpenAI({ apiKey: '平台Key', baseURL: 'http://localhost:3001/v1' })
 *
 * 兼容端点：
 *   POST /v1/chat/completions   — 对话/理解（映射到火山 Responses API）
 *   POST /v1/images/generations  — 图片生成（映射到 Seedream）
 *   GET  /v1/models              — 模型列表
 *
 * 鉴权：Authorization: Bearer <平台API Key>
 * 模型配置全部从 Model 表动态读取，无硬编码
 */

import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { apiKeyAuth } from '../middleware/auth';
import { sha256 } from '../utils/apiKey';
import { loadApiKey } from '../services/volcano';

const VOLCANO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

export default async function openaiCompatRoutes(app: FastifyInstance) {

  // ── GET /v1/models — 模型列表（OpenAI 格式）──
  app.get('/v1/models', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const models = await prisma.model.findMany({ where: { status: 'online' } });
    return {
      object: 'list',
      data: models.map((m) => ({
        id: m.name,
        object: 'model',
        created: Math.floor(m.createdAt.getTime() / 1000),
        owned_by: m.source === 'local' ? 'local' : 'volcengine',
      })),
    };
  });

  // ── POST /v1/chat/completions — 对话/理解（OpenAI 格式）──
  app.post('/v1/chat/completions', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const body = request.body as any;
    const { model: modelName, messages, stream, temperature, max_tokens, max_completion_tokens } = body;

    if (stream) {
      return reply.status(400).send({
        error: { message: 'Stream mode is not yet supported', type: 'invalid_request_error', code: 'stream_not_supported' },
      });
    }

    const startTime = Date.now();

    // 查找模型
    const modelRecord = await prisma.model.findUnique({ where: { name: modelName } });
    if (!modelRecord) {
      return reply.status(404).send({
        error: { message: `The model '${modelName}' does not exist`, type: 'invalid_request_error', code: 'model_not_found' },
      });
    }
    if (modelRecord.status !== 'online') {
      return reply.status(503).send({
        error: { message: `The model '${modelName}' is currently unavailable`, type: 'server_error', code: 'model_unavailable' },
      });
    }

    try {
      // 自部署模型走 OpenAI 兼容格式
      if (modelRecord.source === 'local') {
        const baseUrl = (modelRecord.config as any)?.endpoint || 'http://localhost:11434/v1';
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName, messages, max_tokens, temperature, stream: false }),
        });
        const data = await resp.json() as any;
        const cost = Number(modelRecord.unitCost) || 0.01;
        const duration = Date.now() - startTime;

        await prisma.apiKey.update({
          where: { id: request.apiKeyId },
          data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
        });
        await prisma.callLog.create({
          data: {
            apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
            promptHash: sha256(JSON.stringify(messages)), durationMs: duration, cost, status: 'success',
            ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
          },
        });

        return {
          id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelName,
          choices: [{ index: 0, message: { role: 'assistant', content: data.choices?.[0]?.message?.content || '' }, finish_reason: 'stop' }],
          usage: data.usage || {},
        };
      }

      // 火山引擎模型
      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId || 'doubao-seed-2-1-pro-260628';

      const content: any[] = [];
      for (const msg of messages || []) {
        if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
          content.push({
            type: msg.role === 'assistant' ? 'output_text' : 'input_text',
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          });
        }
      }

      for (const msg of messages || []) {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'image_url') {
              content.push({ type: 'input_image', image_url: part.image_url?.url || part.image_url });
            }
            if (part.type === 'input_video') {
              content.push({ type: 'input_video', video_url: part.video_url?.url || part.video_url });
            }
            if (part.type === 'file') {
              content.push({ type: 'input_file', file_id: part.file_id });
            }
          }
        }
      }

      const reqBody: any = { model: volcanoModel, input: content, stream: false };
      if (max_tokens || max_completion_tokens) reqBody.max_output_tokens = max_completion_tokens || max_tokens;
      if (temperature) reqBody.temperature = temperature;

      const resp = await fetch(`${VOLCANO_BASE}/responses`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      const data = (await resp.json()) as any;
      if (!resp.ok) {
        throw new Error(`火山 API 调用失败 (${resp.status}): ${JSON.stringify(data)}`);
      }

      const outputText = data.output_text || data.output?.[0]?.content?.[0]?.text || '';
      const usage = data.usage || {};

      const cost = Number(modelRecord.unitCost) || 0.1;
      await prisma.apiKey.update({
        where: { id: request.apiKeyId },
        data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
      });

      const duration = Date.now() - startTime;
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
          promptHash: sha256(JSON.stringify(messages)), responseHash: sha256(outputText),
          tokensInput: usage.input_tokens || JSON.stringify(messages).length,
          tokensOutput: usage.output_tokens || outputText.length,
          durationMs: duration, cost, status: 'success',
          ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
        },
      });

      return {
        id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelName,
        choices: [{ index: 0, message: { role: 'assistant', content: outputText }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        },
      };
    } catch (err) {
      return reply.status(500).send({
        error: { message: (err as Error).message, type: 'server_error' },
      });
    }
  });

  // ── POST /v1/images/generations — 图片生成（OpenAI 格式）──
  app.post('/v1/images/generations', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const body = request.body as any;
    const { prompt, model: modelName, n, size, response_format } = body;

    const startTime = Date.now();
    const modelRecord = await prisma.model.findUnique({ where: { name: modelName || 'seedream5.0-pro' } });

    if (!modelRecord || modelRecord.source === 'local' && modelRecord.modelType !== 'image') {
      return reply.status(404).send({ error: { message: `图片生成模型不存在`, type: 'invalid_request_error' } });
    }

    try {
      // 自部署图片模型
      if (modelRecord.source === 'local') {
        const baseUrl = (modelRecord.config as any)?.endpoint || 'http://localhost:7860';
        const resp = await fetch(`${baseUrl}/sdapi/v1/txt2img`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, ...body }),
        });
        const data = await resp.json() as any;
        const cost = Number(modelRecord.unitCost) || 0.05;
        const duration = Date.now() - startTime;
        await prisma.apiKey.update({ where: { id: request.apiKeyId }, data: { quotaUsed: { increment: cost }, lastUsed: new Date() } });
        await prisma.callLog.create({
          data: { apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id, promptHash: sha256(prompt), durationMs: duration, cost, status: 'success', ipAddress: request.ip, userAgent: request.headers['user-agent'] || null },
        });
        return { created: Math.floor(Date.now() / 1000), data: (data.images || []).map((img: string) => ({ url: img })) };
      }

      // 火山引擎图片生成
      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId || 'doubao-seedream-5-0-pro-260628';

      const reqBody: any = {
        model: volcanoModel, prompt, n: n || 1, size: size || '1024x1024',
        response_format: response_format || 'url', output_format: 'png', watermark: false,
      };

      const resp = await fetch(`${VOLCANO_BASE}/images/generations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      const data = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`图片生成失败 (${resp.status}): ${JSON.stringify(data)}`);

      const cost = Number(modelRecord.unitCost) || 0.2;
      await prisma.apiKey.update({
        where: { id: request.apiKeyId },
        data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
      });

      const duration = Date.now() - startTime;
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
          promptHash: sha256(prompt), durationMs: duration, cost, status: 'success',
          ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
        },
      });

      return {
        created: Math.floor(Date.now() / 1000),
        data: (data.data || []).map((img: any) => ({
          url: img.url || null, b64_json: img.b64_json || null, revised_prompt: img.revised_prompt || null,
        })),
      };
    } catch (err) {
      return reply.status(500).send({
        error: { message: (err as Error).message, type: 'server_error' },
      });
    }
  });
}
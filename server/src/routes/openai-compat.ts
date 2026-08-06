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
      // 流式模式：使用 SSE 实时推送 token
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
      // 自部署模型 — 根据模型名判断后端类型
      if (modelRecord.source === 'local') {
        const baseUrl = (modelRecord.config as any)?.endpoint || 'http://localhost:11434';
        const modelType = modelRecord.modelType || 'chat';

        // 模型名约定: ollama/xxx → Ollama, sd/xxx → SD WebUI, comfy/xxx → ComfyUI
        // vllm/xxx 或自定义 label/xxx → OpenAI 兼容 (vLLM)
        const isOllama = modelName.startsWith('ollama/');
        const isSDWebUI = modelName.startsWith('sd/');
        const isComfyUI = modelName.startsWith('comfy/');
        // 去掉前缀，取真实模型名
        const realModelName = modelName.includes('/') ? modelName.slice(modelName.indexOf('/') + 1) : modelName;

        // ── Diffusers 架构: SD WebUI（图片生成）──
        if (isSDWebUI && modelType === 'image') {
          return handleSDWebUIImage(baseUrl, modelName, body, modelRecord, request, reply, startTime);
        }

        // ── Diffusers 架构: ComfyUI（图片生成）──
        if (isComfyUI && modelType === 'image') {
          return handleComfyUIImage(baseUrl, modelName, body, modelRecord, request, reply, startTime);
        }

        // ── LLM 架构: Ollama / vLLM ──

        if (stream) {
          // ── 流式模式 ──
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const chatId = 'chatcmpl-' + Date.now();

          try {
            if (isOllama) {
              // Ollama native stream
              const ollamaResp = await fetch(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: realModelName, messages, stream: true }),
              });

              if (!ollamaResp.ok || !ollamaResp.body) {
                throw new Error('Ollama stream 请求失败');
              }

              const reader = ollamaResp.body.getReader();
              const decoder = new TextDecoder();
              let fullContent = '';

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(l => l.trim());
                for (const line of lines) {
                  try {
                    const parsed = JSON.parse(line);
                    if (parsed.message?.content) {
                      fullContent += parsed.message.content;
                      const sseData = JSON.stringify({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: modelName,
                        choices: [{ index: 0, delta: { content: parsed.message.content }, finish_reason: null }],
                      });
                      reply.raw.write(`data: ${sseData}\n\n`);
                    }
                    if (parsed.done) {
                      const sseData = JSON.stringify({
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: modelName,
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                        usage: { prompt_tokens: parsed.prompt_eval_count || 0, completion_tokens: parsed.eval_count || 0, total_tokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0) },
                      });
                      reply.raw.write(`data: ${sseData}\n\n`);
                    }
                  } catch { /* 跳过非 JSON 行 */ }
                }
              }

              // 记录日志
              const cost = Number(modelRecord.unitCost) || 0.01;
              await prisma.apiKey.update({
                where: { id: request.apiKeyId },
                data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
              });
              await prisma.callLog.create({
                data: {
                  apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
                  promptHash: sha256(JSON.stringify(messages)), responseHash: sha256(fullContent),
                  tokensOutput: fullContent.length, durationMs: Date.now() - startTime, cost, status: 'success',
                  ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
                },
              });
            } else {
              // vLLM OpenAI-compatible stream
              const vllmResp = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: realModelName, messages, max_tokens, temperature, stream: true }),
              });

              if (!vllmResp.ok || !vllmResp.body) {
                throw new Error('vLLM stream 请求失败');
              }

              const reader = vllmResp.body.getReader();
              const decoder = new TextDecoder();
              let fullContent = '';

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
                for (const line of lines) {
                  try {
                    const parsed = JSON.parse(line.slice(6));
                    if (parsed === '[DONE]') continue;
                    // 直接转发
                    reply.raw.write(`data: ${JSON.stringify(parsed)}\n\n`);
                    const delta = parsed.choices?.[0]?.delta?.content || '';
                    if (delta) fullContent += delta;
                  } catch { /* skip */ }
                }
              }

              const cost = Number(modelRecord.unitCost) || 0.01;
              await prisma.apiKey.update({
                where: { id: request.apiKeyId },
                data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
              });
              await prisma.callLog.create({
                data: {
                  apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
                  promptHash: sha256(JSON.stringify(messages)), responseHash: sha256(fullContent),
                  tokensOutput: fullContent.length, durationMs: Date.now() - startTime, cost, status: 'success',
                  ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
                },
              });
            }
          } catch (err) {
            // 流式错误用 SSE 格式返回
            const errData = JSON.stringify({
              error: { message: (err as Error).message, type: 'server_error' },
            });
            reply.raw.write(`data: ${errData}\n\ndata: [DONE]\n\n`);
          }

          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
          return;
        }

        // ── 非流式模式 ──
        let resp: any;
        let rawText: string;
        if (isOllama) {
          // Ollama native /api/chat
          resp = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: realModelName, messages, stream: false }),
          });
          rawText = await resp.text();
        } else {
          // OpenAI-compatible (vLLM etc.)
          resp = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: realModelName, messages, max_tokens, temperature, stream: false }),
          });
          rawText = await resp.text();
        }

        let data: any;
        try { data = JSON.parse(rawText); } catch { throw new Error(`本地模型返回非 JSON: ${rawText.substring(0, 200)}`); }
        if (!resp.ok || data.error) {
          throw new Error(data.error?.message || `本地模型返回 ${resp.status}: ${rawText.substring(0, 200)}`);
        }

        // 提取回复内容（兼容 Ollama 和 OpenAI 格式）
        const replyText = data.choices?.[0]?.message?.content || data.message?.content || '';
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
          choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
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

  // ── POST /v1/images/edits — 图生图（OpenAI 格式）──
  // 接受 image (data URI) 或 images (base64 array) 作为参考图，转发给火山 Seedream
  app.post('/v1/images/edits', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const body = request.body as any;
    const { prompt, model: modelName, image, images, n, size, response_format } = body;

    const startTime = Date.now();
    const modelRecord = await prisma.model.findUnique({ where: { name: modelName || 'seedream5.0-pro' } });
    if (!modelRecord) {
      return reply.status(404).send({ error: { message: `图片生成模型不存在`, type: 'invalid_request_error' } });
    }

    try {
      if (modelRecord.source === 'local') {
        // 自部署模型：img2img
        const baseUrl = (modelRecord.config as any)?.endpoint || 'http://localhost:7860';
        const reqBody: any = { prompt, ...body };
        if (image) reqBody.init_images = [image.startsWith('data:') ? image.split(',')[1] : image];
        if (Array.isArray(images) && images.length > 0) reqBody.init_images = images;
        const resp = await fetch(`${baseUrl}/sdapi/v1/img2img`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        });
        const data = await resp.json() as any;
        const cost = Number(modelRecord.unitCost) || 0.05;
        const duration = Date.now() - startTime;
        await prisma.apiKey.update({ where: { id: request.apiKeyId }, data: { quotaUsed: { increment: cost }, lastUsed: new Date() } });
        await prisma.callLog.create({
          data: { apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id, promptHash: sha256(prompt), durationMs: duration, cost, status: 'success', ipAddress: request.ip, userAgent: request.headers['user-agent'] || null },
        });
        return { created: Math.floor(Date.now() / 1000), data: (data.images || []).map((img: string) => ({ b64_json: img, url: img.startsWith('data:') ? undefined : img })) };
      }

      // 火山引擎图片生成（图生图模式）
      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId || 'doubao-seedream-5-0-pro-260628';

      const reqBody: any = {
        model: volcanoModel, prompt: prompt || '', n: n || 1, size: size || '1024x1024',
        response_format: response_format || 'url', output_format: 'png', watermark: false,
      };

      // 参考图：优先 images 数组，否则 image 字段
      if (Array.isArray(images) && images.length > 0) {
        reqBody.image = image.startsWith('data:') ? image : 'data:image/jpeg;base64,' + images[0];
        // 多余图片通过 images 字段传（若平台支持）
        if (images.length > 1) reqBody.images = images.slice(1).map((b: string) => b.startsWith('data:') ? b : 'data:image/jpeg;base64,' + b);
      } else if (image) {
        reqBody.image = image.startsWith('data:') ? image : 'data:image/jpeg;base64,' + image;
      }

      const resp = await fetch(`${VOLCANO_BASE}/images/generations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      const data = (await resp.json()) as any;
      if (!resp.ok) throw new Error(`图生图失败 (${resp.status}): ${JSON.stringify(data)}`);

      const cost = Number(modelRecord.unitCost) || 0.2;
      const duration = Date.now() - startTime;
      await prisma.apiKey.update({
        where: { id: request.apiKeyId },
        data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
      });
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

  // ── POST /v1/video/generations — 视频生成（OpenAI 格式）──
  app.post('/v1/video/generations', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const body = request.body as any;
    const { prompt, model: modelName, duration, ratio, resolution, images, videos, audios, generate_audio, return_last_frame, service_tier } = body;

    const startTime = Date.now();

    // 查找模型
    const modelRecord = await prisma.model.findUnique({ where: { name: modelName || 'doubao-seedance-2-0-260128' } });
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
      if (modelRecord.source !== 'volcano' || modelRecord.modelType !== 'video') {
        return reply.status(400).send({
          error: { message: `视频生成仅支持火山引擎视频模型`, type: 'invalid_request_error' },
        });
      }

      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId || 'doubao-seedance-2-0-260128';

      // 构建请求体（与 generate.ts 中 callVolcanoVideo 逻辑一致）
      const content: any[] = [{ type: 'text', text: prompt || '' }];

      for (const img of images || []) {
        content.push({ type: 'image_url', image_url: { url: typeof img === 'string' ? img : img.url }, role: 'reference_image' });
      }
      for (const vid of videos || []) {
        content.push({ type: 'video_url', video_url: { url: typeof vid === 'string' ? vid : vid.url }, role: 'reference_video' });
      }
      for (const aud of audios || []) {
        content.push({ type: 'audio_url', audio_url: { url: typeof aud === 'string' ? aud : aud.url }, role: 'reference_audio' });
      }

      const reqBody: any = {
        model: volcanoModel,
        content,
        duration: duration || 5,
        ratio: body.ratio || '16:9',
        watermark: false,
      };
      if (resolution) reqBody.resolution = resolution;
      if (generate_audio) reqBody.generate_audio = true;
      if (return_last_frame) reqBody.return_last_frame = true;
      if (service_tier) reqBody.service_tier = service_tier;

      const resp = await fetch(`${VOLCANO_BASE}/contents/generations/tasks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`视频生成请求失败 (${resp.status}): ${errText}`);
      }

      const createData = (await resp.json()) as any;
      const taskId = createData.id;
      if (!taskId) throw new Error(`视频任务创建失败: ${JSON.stringify(createData)}`);

      // 轮询等待任务完成（最多 10 分钟）
      const taskUrl = `${VOLCANO_BASE}/contents/generations/tasks/${taskId}`;
      let waited = 0;

      while (waited < 600000) {
        await new Promise(r => setTimeout(r, 10000));
        waited += 10000;

        const taskResp = await fetch(taskUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
        const taskData = (await taskResp.json()) as any;

        if (taskData.status === 'succeeded') {
          const usage = taskData.usage || {};
          const cost = Number(modelRecord.unitCost) || 0.5;
          const duration = Date.now() - startTime;

          await prisma.apiKey.update({
            where: { id: request.apiKeyId },
            data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
          });
          await prisma.callLog.create({
            data: {
              apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
              promptHash: sha256(prompt || ''), durationMs: duration, cost, status: 'success',
              ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
            },
          });

          return {
            task_id: taskId,
            created: Math.floor(Date.now() / 1000),
            data: [{
              url: taskData.content?.video?.url || taskData.content?.video_url || null,
              last_frame: taskData.content?.last_frame_image?.url || null,
              task_id: taskId,
            }],
            usage: {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            },
          };
        }

        if (taskData.status === 'failed') {
          throw new Error(`视频任务失败: ${JSON.stringify(taskData.error || taskData)}`);
        }
      }

      // 超时：返回任务 ID 供客户端轮询
      return reply.status(202).send({
        task_id: taskId,
        status: 'processing',
        message: '视频生成处理中，请通过 GET /v1/video/generations/:taskId 查询进度',
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord?.id,
          promptHash: sha256(prompt || ''), durationMs: duration, status: 'failed',
          ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
        },
      }).catch(() => {});
      return reply.status(500).send({
        error: { message: (err as Error).message, type: 'server_error' },
      });
    }
  });

  // ── GET /v1/video/generations/:taskId — 查询视频任务状态 ──
  app.get('/v1/video/generations/:taskId', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      const apiKey = await loadApiKey();
      const resp = await fetch(`${VOLCANO_BASE}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = (await resp.json()) as any;
      return {
        task_id: taskId,
        status: data.status,
        video_url: data.content?.video?.url || data.content?.video_url || null,
        last_frame: data.content?.last_frame_image?.url || null,
        usage: data.usage,
        error: data.error,
      };
    } catch (err) {
      return reply.status(500).send({
        error: { message: (err as Error).message, type: 'server_error' },
      });
    }
  });
}

// ──────────────────────────────────────────────
// Diffusers 架构处理函数
// ──────────────────────────────────────────────

/** 通过 SD WebUI /sdapi/v1/txt2img 生成图片 */
async function handleSDWebUIImage(
  baseUrl: string, modelName: string, body: any,
  modelRecord: any, request: any, reply: any, startTime: number
) {
  const { prompt, n, size, response_format } = body;
  const realModelName = modelName.includes('/') ? modelName.split('/')[1] : modelName;

  try {
    const sdBody: any = { prompt, negative_prompt: body.negative_prompt || '' };
    if (n) sdBody.batch_size = n;
    if (size) {
      const [w, h] = size.split('x').map(Number);
      if (w && h) { sdBody.width = w; sdBody.height = h; }
    }

    const resp = await fetch(`${baseUrl}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sdBody),
    });

    const data = (await resp.json()) as any;
    if (!resp.ok) throw new Error(`SD WebUI 调用失败 (${resp.status}): ${JSON.stringify(data).substring(0, 200)}`);

    const cost = Number(modelRecord.unitCost) || 0.1;
    const duration = Date.now() - startTime;

    await prisma.apiKey.update({
      where: { id: request.apiKeyId },
      data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
    });
    await prisma.callLog.create({
      data: {
        apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
        promptHash: sha256(prompt), durationMs: duration, cost, status: 'success',
        ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
      },
    });

    return {
      created: Math.floor(Date.now() / 1000),
      data: (data.images || []).map((img: string) => ({
        b64_json: img,
        url: response_format === 'url' ? `data:image/png;base64,${img}` : undefined,
      })),
    };
  } catch (err) {
    return reply.status(500).send({
      error: { message: (err as Error).message, type: 'server_error' },
    });
  }
}

/** 通过 ComfyUI /prompt API 生成图片 */
async function handleComfyUIImage(
  baseUrl: string, modelName: string, body: any,
  modelRecord: any, request: any, reply: any, startTime: number
) {
  const { prompt, negative_prompt, size } = body;
  const [width, height] = (size || '1024x1024').split('x').map(Number);

  try {
    // 构建 ComfyUI 基础工作流
    const workflow = {
      '3': { class_type: 'KSampler', inputs: { seed: Math.floor(Math.random() * 1e9), steps: 25, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: modelName.split('/')[1] || '' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: negative_prompt || '', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'maas', images: ['8', 0] } },
    };

    // 提交工作流
    const submitResp = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
    });

    const submitData = (await submitResp.json()) as any;
    if (!submitResp.ok) throw new Error(`ComfyUI 提交失败: ${JSON.stringify(submitData).substring(0, 200)}`);

    const promptId = submitData.prompt_id;

    // 轮询等待完成（最多 5 分钟）
    const maxWait = 300000;
    const pollInterval = 2000;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      waited += pollInterval;

      const histResp = await fetch(`${baseUrl}/history/${promptId}`);
      const histData = (await histResp.json()) as any;
      const entry = histData[promptId];

      if (entry?.outputs) {
        const outputs = entry.outputs;
        const images: { b64_json?: string; url?: string }[] = [];

        for (const nodeOutput of Object.values(outputs) as any[]) {
          for (const img of nodeOutput.images || []) {
            const fileResp = await fetch(`${baseUrl}/view?filename=${img.filename}&type=${img.type}`);
            const buffer = await fileResp.arrayBuffer();
            const b64 = Buffer.from(buffer).toString('base64');
            images.push({ b64_json: b64, url: `data:image/png;base64,${b64}` });
          }
        }

        if (images.length > 0) {
          const cost = Number(modelRecord.unitCost) || 0.1;
          const duration = Date.now() - startTime;
          await prisma.apiKey.update({
            where: { id: request.apiKeyId },
            data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
          });
          await prisma.callLog.create({
            data: {
              apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
              promptHash: sha256(prompt), durationMs: duration, cost, status: 'success',
              ipAddress: request.ip, userAgent: request.headers['user-agent'] || null,
            },
          });

          return { created: Math.floor(Date.now() / 1000), data: images };
        }
      }
    }

    return reply.status(408).send({
      error: { message: 'ComfyUI 生成超时', type: 'timeout' },
    });
  } catch (err) {
    return reply.status(500).send({
      error: { message: (err as Error).message, type: 'server_error' },
    });
  }
}
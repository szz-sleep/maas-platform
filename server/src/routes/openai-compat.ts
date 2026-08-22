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
import { apiKeyAuth, checkKeyModelAllowed, getAllowedModelIds } from '../middleware/auth';
import { sha256 } from '../utils/apiKey';
import { loadApiKey, loadAksk } from '../services/volcano';
import { signedRequest } from '../services/volcano-signature';
import { computeCost } from '../services/pricing';

// 火山 OpenAPI 主机（GetAsset 等素材管理接口）
const VOLC_HOST = 'open.volcengineapi.com';

/**
 * 将素材库引用转成火山可下载的真实图片 URL。
 * Seedream 的 image 字段只接受真实 URL / base64，不接受 asset:// 引用。
 * 通过火山 GetAsset 接口取回该素材在火山素材库的 URL，保证火山能访问。
 * @param assetRef - 形如 "asset://<asset_id>" 的引用；非 asset:// 原样返回
 */
async function resolveAssetUrl(assetRef: string): Promise<string | null> {
  if (typeof assetRef !== 'string' || !assetRef.startsWith('asset://')) return assetRef;
  const assetId = assetRef.slice('asset://'.length);
  if (!assetId) return null;
  try {
    // 调火山 GetAsset 拿真实 URL（权威，火山侧一定可下载；不用本地缓存的 uguu.se 临时图——火山常下载超时）
    const { ak, sk, projectName } = await loadAksk();
    const resp = await signedRequest(ak, sk, {
      method: 'POST',
      host: VOLC_HOST,
      path: '/',
      query: 'Action=GetAsset&Version=2024-01-01',
      body: { Id: assetId, ProjectName: projectName },
      service: 'ark',
    });
    const data = (await resp.json()) as any;
    const result = data?.Result || data?.Response?.Result;
    const url = result?.URL || result?.Url;
    if (url && typeof url === 'string' && url.startsWith('http')) {
      return url;
    }
    // 火山无结果时回退到本地缓存 URL（仅当是 http 真实图，且非 uguu.se 时优先；uguu.se 可能下载超时但作为最后兜底）
    const local = await prisma.asset.findUnique({ where: { volcAssetId: assetId } });
    if (local?.sourceUrl && local.sourceUrl.startsWith('http')) return local.sourceUrl;
    return null;
  } catch (e) {
    console.log('[图片编辑] 解析素材URL失败:', assetId, (e as Error).message);
    return null;
  }
}

/**
 * 计费计算器 — 对齐火山引擎计价方式
 * - chat/embedding：元/百万tokens（input/output 分别计价）
 * - video：元/秒（unitCostPerSecond × 时长）
 * - image/3d：元/次（unitCost）
 */
function calcCost(model: any, inputTokens?: number, outputTokens?: number, durationSeconds?: number): number {
  const per1mIn = Number(model.per1mInputTokens || 0);
  const per1mOut = Number(model.per1mOutputTokens || 0);
  // token 计费（chat/embedding）
  if ((per1mIn > 0 || per1mOut > 0) && inputTokens !== undefined) {
    return Number((((inputTokens || 0) / 1_000_000) * per1mIn + ((outputTokens || 0) / 1_000_000) * per1mOut).toFixed(6));
  }
  // 按秒计费（video）
  const perSec = Number(model.unitCostPerSecond || 0);
  if (perSec > 0 && durationSeconds) {
    return Number((durationSeconds * perSec).toFixed(6));
  }
  // 按次计费（image/3d/自部署）
  return Number(model.unitCost || 0.01);
}

const VOLCANO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * 判断图片 size 是否为高像素（>1.5K，即总像素 > 261万）。
 * 文档：单图生成 ≤261万像素(1.5K及以下) 0.30 元/张；>261万像素(1.5K以上) 0.60 元/张
 */
function computePageSize(size?: string): { highPixels: boolean; pixels: number } {
  let pixels = 0;
  if (size) {
    const m = String(size).toLowerCase().match(/(\d+)\s*x\s*(\d+)/);
    if (m) {
      pixels = parseInt(m[1]) * parseInt(m[2]);
    }
  }
  return { highPixels: pixels > 2_610_000, pixels };
}

export default async function openaiCompatRoutes(app: FastifyInstance) {

  // ── GET /v1/models — 模型列表（OpenAI 格式）──
  app.get('/v1/models', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    // 按 Key 模型映射过滤：仅返回该 Key 允许的模型；未配置映射 → 空列表
    const allowed = await getAllowedModelIds(request.apiKeyId!);
    let where: any = { status: 'online' };
    if (allowed instanceof Set) {
      where.id = { in: Array.from(allowed) };
    } else if (allowed === null) {
      where.id = { in: [] }; // 未配置映射的 Key 看不到任何模型
    }
    const models = await prisma.model.findMany({ where });
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

    // Key 模型映射校验
    const denyReason = await checkKeyModelAllowed(request.apiKeyId, modelRecord.id);
    if (denyReason) {
      return reply.status(403).send({
        error: { message: denyReason, type: 'invalid_request_error', code: 'model_not_allowed' },
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

              // 记录日志（自部署 chat 无 tokens 信息，按次计费）
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
              // vLLM / llama.cpp OpenAI-compatible stream
              // MAAS_OPENCLAW_STREAM_COMPAT_V3
              // MAAS_OPENCLAW_TOOL_SCHEMA_COMPAT_V3_1
              const sanitizeSchemaForLlama = (value: any): any => {
                if (Array.isArray(value)) {
                  return value.map((item) => sanitizeSchemaForLlama(item));
                }

                if (!value || typeof value !== 'object') {
                  return value;
                }

                const out: any = {};

                for (const [key, child] of Object.entries(value)) {
                  if (
                    key === 'pattern' &&
                    typeof child === 'string' &&
                    !(child.startsWith('^') && child.endsWith('$'))
                  ) {
                    continue;
                  }

                  out[key] = sanitizeSchemaForLlama(child);
                }

                return out;
              };

              const sanitizedToolsForLlama =
                body.tools !== undefined
                  ? sanitizeSchemaForLlama(body.tools)
                  : undefined;

              const localStreamBody: any = {
                model: realModelName,
                messages,
                stream: true,
              };

              const passthroughKeys = [
                'tools',
                'tool_choice',
                'parallel_tool_calls',
                'temperature',
                'top_p',
                'max_tokens',
                'max_completion_tokens',
                'seed',
                'stop',
                'presence_penalty',
                'frequency_penalty',
                'response_format',
                'logit_bias',
                'n',
                'user',
              ];

              for (const key of passthroughKeys) {
                if (body[key] !== undefined) {
                  localStreamBody[key] =
                    key === 'tools' ? sanitizedToolsForLlama : body[key];
                }
              }

              for (const key of Object.keys(localStreamBody)) {
                if (localStreamBody[key] === null) {
                  delete localStreamBody[key];
                }
              }

              const vllmResp = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(localStreamBody),
              });

              if (!vllmResp.ok || !vllmResp.body) {
                const upstreamError = await vllmResp.text().catch(() => '');
                throw new Error(
                  `vLLM stream 请求失败 (${vllmResp.status}): ${upstreamError.substring(0, 500)}`
                );
              }

              const reader = vllmResp.body.getReader();
              const decoder = new TextDecoder();
              let fullContent = '';
              let sseBuffer = '';

              const writeOpenAIEvent = (parsed: any) => {
                const choice = parsed?.choices?.[0];
                const delta = choice?.delta;

                if (delta && typeof delta === 'object') {
                  if ('reasoning_content' in delta) {
                    delete delta.reasoning_content;
                  }

                  const deltaKeys = Object.keys(delta).filter((k) => {
                    if (k === 'role' && delta[k] === 'assistant') return false;
                    return delta[k] !== undefined && delta[k] !== null && delta[k] !== '';
                  });

                  const hasFinish = choice?.finish_reason !== null &&
                    choice?.finish_reason !== undefined;

                  if (deltaKeys.length === 0 && !hasFinish) {
                    return;
                  }

                  if (typeof delta.content === 'string' && delta.content) {
                    fullContent += delta.content;
                  }
                }

                reply.raw.write(`data: ${JSON.stringify(parsed)}\n\n`);
              };

              const processSseBlock = (block: string) => {
                const lines = block.split(/\r?\n/);

                for (const line of lines) {
                  if (!line.startsWith('data:')) continue;

                  const payload = line.slice(5).trimStart();

                  if (!payload || payload === '[DONE]') {
                    continue;
                  }

                  try {
                    const parsed = JSON.parse(payload);
                    writeOpenAIEvent(parsed);
                  } catch {
                    // best-effort compatibility
                  }
                }
              };

              while (true) {
                const { done, value } = await reader.read();

                if (done) {
                  sseBuffer += decoder.decode();

                  if (sseBuffer.trim()) {
                    processSseBlock(sseBuffer);
                  }

                  break;
                }

                sseBuffer += decoder.decode(value, { stream: true });

                while (true) {
                  const match = /\r?\n\r?\n/.exec(sseBuffer);
                  if (!match || match.index === undefined) break;

                  const eventBlock = sseBuffer.slice(0, match.index);
                  sseBuffer = sseBuffer.slice(match.index + match[0].length);

                  if (eventBlock.trim()) {
                    processSseBlock(eventBlock);
                  }
                }
              }
              const cost = calcCost(modelRecord);
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
            body: JSON.stringify({
              ...body,
              model: realModelName,
              messages,
              stream: false,
            }),
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
        const cost = calcCost(modelRecord);
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

        if (!isOllama && Array.isArray(data.choices)) {
          return {
            ...data,
            model: modelName,
          };
        }

        return {
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: replyText,
            },
            finish_reason: 'stop',
          }],
          usage: data.usage || {},
        };
      }

      // 火山引擎模型
      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId;
      if (!volcanoModel) {
        return reply.status(400).send({ error: { message: '模型未关联火山引擎模型ID', type: 'invalid_request_error' } });
      }

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
      const tin = usage.input_tokens || JSON.stringify(messages).length;
      const tout = usage.output_tokens || outputText.length;

      // 新计费引擎：按 ModelPrice 标准价计算 + 记录单价/公式
      const pricing = await computeCost({
        modelName: modelName, modelType: modelRecord.modelType, source: modelRecord.source,
        tokensInput: tin, tokensOutput: tout,
      });
      const cost = pricing.cost;
      await prisma.apiKey.update({
        where: { id: request.apiKeyId },
        data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
      });

      const duration = Date.now() - startTime;
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
          promptHash: sha256(JSON.stringify(messages)), responseHash: sha256(outputText),
          tokensInput: tin, tokensOutput: tout,
          durationMs: duration, cost, status: 'success',
          unitInfo: { unit: pricing.unit, weightedUnit: pricing.weightedUnit, formula: pricing.formula, modelType: modelRecord.modelType },
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
    if (!modelName) {
      return reply.status(400).send({ error: { message: '请指定图片模型', type: 'invalid_request_error' } });
    }
    const modelRecord = await prisma.model.findUnique({ where: { name: modelName } });

    if (!modelRecord || modelRecord.source === 'local' && modelRecord.modelType !== 'image') {
      return reply.status(404).send({ error: { message: `图片生成模型不存在`, type: 'invalid_request_error' } });
    }

    // Key 模型映射校验
    const denyReason = await checkKeyModelAllowed(request.apiKeyId, modelRecord.id);
    if (denyReason) {
      return reply.status(403).send({ error: { message: denyReason, type: 'invalid_request_error', code: 'model_not_allowed' } });
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
        const cost = calcCost(modelRecord);
        const duration = Date.now() - startTime;
        await prisma.apiKey.update({ where: { id: request.apiKeyId }, data: { quotaUsed: { increment: cost }, lastUsed: new Date() } });
        await prisma.callLog.create({
          data: { apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id, promptHash: sha256(prompt), durationMs: duration, cost, status: 'success', ipAddress: request.ip, userAgent: request.headers['user-agent'] || null },
        });
        return { created: Math.floor(Date.now() / 1000), data: (data.images || []).map((img: string) => ({ url: img })) };
      }

      // 火山引擎图片生成
      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId;
      if (!volcanoModel) {
        return reply.status(400).send({ error: { message: '模型未关联火山引擎模型ID', type: 'invalid_request_error' } });
      }

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

      // 图片按张计费（per_image 模式，元/张）
      const imageCount = Array.isArray(data.data) ? data.data.length : (n || 1);
      const pagination = computePageSize(size);
      const pricing = await computeCost({
        modelName: modelName, modelType: 'image', source: modelRecord.source,
        imageCount, imageHighPixels: pagination.highPixels,
      });
      const cost = pricing.cost;
      await prisma.apiKey.update({
        where: { id: request.apiKeyId },
        data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
      });

      const duration = Date.now() - startTime;
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
          promptHash: sha256(prompt), durationMs: duration, cost, status: 'success',
          unitInfo: { unit: pricing.unit, weightedUnit: pricing.weightedUnit, formula: pricing.formula, modelType: 'image', imageCount },
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
    if (!modelName) {
      return reply.status(400).send({ error: { message: '请指定图片模型', type: 'invalid_request_error' } });
    }
    const modelRecord = await prisma.model.findUnique({ where: { name: modelName } });
    if (!modelRecord) {
      return reply.status(404).send({ error: { message: `图片生成模型不存在`, type: 'invalid_request_error' } });
    }

    // Key 模型映射校验
    const denyReason = await checkKeyModelAllowed(request.apiKeyId, modelRecord.id);
    if (denyReason) {
      return reply.status(403).send({ error: { message: denyReason, type: 'invalid_request_error', code: 'model_not_allowed' } });
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
        const pricing = await computeCost({
          modelName: modelName, modelType: 'image', source: modelRecord.source,
          imageCount: (Array.isArray(data.images) ? data.images.length : 1), imageHighPixels: computePageSize(size).highPixels,
        });
        const cost = pricing.cost;
        const duration = Date.now() - startTime;
        await prisma.apiKey.update({ where: { id: request.apiKeyId }, data: { quotaUsed: { increment: cost }, lastUsed: new Date() } });
        await prisma.callLog.create({
          data: { apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id, promptHash: sha256(prompt), durationMs: duration, cost, status: 'success', unitInfo: { unit: pricing.unit, weightedUnit: pricing.weightedUnit, formula: pricing.formula, modelType: 'image' }, ipAddress: request.ip, userAgent: request.headers['user-agent'] || null },
        });
        return { created: Math.floor(Date.now() / 1000), data: (data.images || []).map((img: string) => ({ b64_json: img, url: img.startsWith('data:') ? undefined : img })) };
      }

      // 火山引擎图片生成（图生图模式）
      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId;
      if (!volcanoModel) {
        return reply.status(400).send({ error: { message: '模型未关联火山引擎模型ID', type: 'invalid_request_error' } });
      }

      const reqBody: any = {
        model: volcanoModel, prompt: prompt || '', n: n || 1, size: size || '1024x1024',
        response_format: response_format || 'url', output_format: 'png', watermark: false,
      };

      // 参考图：优先 images 数组，否则 image 字段
      // 多图参考：官方文档支持 image 字段传数组（string[]），最多10张
      // Seedream 的 image 字段只认真实 URL/base64，不认 asset:// → 先把 asset:// 素材转成火山可下载的真实 URL
      if (Array.isArray(images) && images.length > 0) {
        const resolved: (string | null)[] = [];
        for (const img of images) {
          resolved.push(await resolveAssetUrl(img));
        }
        reqBody.image = resolved.filter((v): v is string => !!v);
      } else if (image) {
        reqBody.image = await resolveAssetUrl(image);
      }
      // 调试日志：打印实际发给火山的图生图请求体（便于核对多图参考与素材URL解析）
      console.log('[图片编辑] 请求体:', JSON.stringify(reqBody).substring(0, 2000));

      const resp = await fetch(`${VOLCANO_BASE}/images/generations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      const data = (await resp.json()) as any;
      if (!resp.ok) {
        console.log('[图片编辑] 火山返回错误:', resp.status, JSON.stringify(data).substring(0, 1500));
        throw new Error(`图生图失败 (${resp.status}): ${JSON.stringify(data)}`);
      }

      const pricing = await computeCost({
        modelName: modelName, modelType: 'image', source: modelRecord.source,
        imageCount: (Array.isArray(data.data) ? data.data.length : (n || 1)), imageHighPixels: computePageSize(size).highPixels,
      });
      const cost = pricing.cost;
      const duration = Date.now() - startTime;
      await prisma.apiKey.update({
        where: { id: request.apiKeyId },
        data: { quotaUsed: { increment: cost }, lastUsed: new Date() },
      });
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId, userId: request.apiKeyUserId, modelId: modelRecord.id,
          promptHash: sha256(prompt), durationMs: duration, cost, status: 'success',
          unitInfo: { unit: pricing.unit, weightedUnit: pricing.weightedUnit, formula: pricing.formula, modelType: 'image' },
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

    const cost = calcCost(modelRecord);
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
          const cost = calcCost(modelRecord);
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
/**
 * 理解类接口 — 视频/图片/文档/音频理解
 *
 * 接口：POST /api/v3/responses
 * 鉴权：API Key
 * 模型配置从 Model 表动态读取，无硬编码
 */

import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { apiKeyAuth, checkKeyModelAllowed } from '../middleware/auth';
import { sha256 } from '../utils/apiKey';
import { loadApiKey } from '../services/volcano';

const VOLCANO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

export default async function understandRoutes(app: FastifyInstance) {
  app.post('/api/v1/understand', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const body = request.body as any;
    const { prompt, type, model: modelName, images, videos, file_ids, audios, max_tokens, temperature } = body;

    const startTime = Date.now();

    // 根据 type 确定模型名，或使用指定的 model
    const resolvedName = modelName || (type === 'audio' ? 'seed2.0-audio' : 'seed2.1-vision');

    try {
      const modelRecord = await prisma.model.findUnique({ where: { name: resolvedName } });
      if (!modelRecord) {
        return reply.status(404).send({ success: false, error: { code: 'MODEL_NOT_FOUND', message: `模型 "${resolvedName}" 不存在` } });
      }
      if (modelRecord.status !== 'online') {
        return reply.status(503).send({ success: false, error: { code: 'MODEL_OFFLINE', message: '模型当前不可用' } });
      }

      // Key 模型映射校验
      const denyReason = await checkKeyModelAllowed(request.apiKeyId, modelRecord.id);
      if (denyReason) {
        return reply.status(403).send({ success: false, error: { code: 'MODEL_NOT_ALLOWED', message: denyReason } });
      }

      const apiKey = await loadApiKey();
      const volcanoModel = modelRecord.volcanoModelId;
      if (!volcanoModel) {
        return reply.status(400).send({ error: { message: '模型未关联火山引擎模型ID', type: 'invalid_request_error' } });
      }

      const content: any[] = [{ type: 'input_text', text: prompt || '请描述这个内容' }];

      if (images?.length) {
        for (const img of images) content.push({ type: 'input_image', image_url: img });
      }
      if (videos?.length) {
        for (const vid of videos) {
          content.push(vid.startsWith('file-')
            ? { type: 'input_file', file_id: vid }
            : { type: 'input_video', video_url: vid });
        }
      }
      if (file_ids?.length) {
        for (const fid of file_ids) content.push({ type: 'input_file', file_id: fid });
      }
      if (audios?.length) {
        for (const aud of audios) content.push({ type: 'input_audio', audio_url: aud });
      }

      const reqBody: any = { model: volcanoModel, input: content, stream: false };
      if (max_tokens) reqBody.max_output_tokens = max_tokens;
      if (temperature) reqBody.temperature = temperature;

      const resp = await fetch(`${VOLCANO_BASE}/responses`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      const data = (await resp.json()) as any;
      if (!resp.ok) {
        throw new Error(`理解请求失败 (${resp.status}): ${JSON.stringify(data)}`);
      }

      const duration = Date.now() - startTime;
      await prisma.callLog.create({
        data: {
          apiKeyId: request.apiKeyId,
          userId: request.apiKeyUserId,
          modelId: modelRecord.id,
          promptHash: sha256(JSON.stringify(content)),
          responseHash: sha256(JSON.stringify(data)),
          tokensInput: prompt?.length || 0,
          tokensOutput: data.output_text?.length || data.usage?.output_tokens || 0,
          durationMs: duration,
          cost: Number(modelRecord.unitCost) || 0.1,
          status: 'success',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] || null,
        },
      });

      return {
        success: true,
        data: { response: data.output_text || data.output, usage: data.usage, type, model: volcanoModel },
        usage: { durationMs: duration },
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'UNDERSTAND_FAILED', message: (err as Error).message },
      });
    }
  });
}
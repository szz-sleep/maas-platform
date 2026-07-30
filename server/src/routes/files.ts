/**
 * 文件上传路由 — 对接火山引擎 Files API
 *
 * 接口：POST /api/v3/files
 * 用途：上传视频/图片/文档/音频，获取 file_id，用于后续理解类请求
 *
 * 限制：
 *   视频/文档 ≤ 512MB（方舟 Storage）或 ≤ 2GB（TOS）
 *   图片 Base64 ≤ 10MB
 *   音频 Base64 ≤ 25MB，≤ 120min
 *
 * 鉴权：API Key
 */

import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { apiKeyAuth } from '../middleware/auth';
import { loadApiKey } from '../services/volcano';

const VOLCANO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

export default async function fileRoutes(app: FastifyInstance) {
  // ── 上传文件 ──
  app.post('/api/v1/files/upload', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ success: false, error: { code: 'NO_FILE', message: '请上传文件' } });
      }

      const buffer = await data.toBuffer();
      const apiKey = await loadApiKey();

      const formData = new FormData();
      formData.append('purpose', 'user_data');
      formData.append('file', new Blob([new Uint8Array(buffer)], { type: data.mimetype }), data.filename);

      const resp = await fetch(`${VOLCANO_BASE}/files`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData,
      });

      const result = (await resp.json()) as any;
      if (!resp.ok) {
        throw new Error(`文件上传失败 (${resp.status}): ${JSON.stringify(result)}`);
      }

      return {
        success: true,
        data: {
          file_id: result.id,
          filename: result.filename,
          bytes: result.bytes,
          created_at: result.created_at,
          purpose: result.purpose,
        },
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'UPLOAD_FAILED', message: (err as Error).message },
      });
    }
  });
}
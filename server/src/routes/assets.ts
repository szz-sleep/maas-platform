/**
 * 素材管理路由 — 火山引擎素材库（需要 AK/SK 签名）
 *
 * API：
 *   POST /api/v1/assets/create — 上传素材（图片/视频/音频）到火山引擎素材库
 *   GET  /api/v1/assets/:assetId — 查询素材状态
 *   GET  /api/v1/assets — 列出素材
 *
 * 素材入库流程：
 *   1. CreateAsset → 返回 asset_id
 *   2. 轮询 GetAsset → 直到 Status = "active"
 *   3. 生成时用 asset://<asset_id> 引用
 */

import { FastifyInstance } from 'fastify';
import { adminAuth } from '../middleware/auth';
import { loadAksk } from '../services/volcano';
import { signedRequest } from '../services/volcano-signature';
import prisma from '../config/database';

// 火山引擎 OpenAPI 域名（Ark 服务）
const VOLC_OPENAPI_HOST = 'open.volcengineapi.com';

export default async function assetRoutes(app: FastifyInstance) {
  // ── 上传素材 ──
  app.post('/api/v1/assets/create', { preHandler: [adminAuth] }, async (request, reply) => {
    const body = request.body as Record<string, any>;
    const { assetGroupId, assetName, assetType, assetUrl, description } = body || {};

    if (!assetGroupId) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '素材组 ID 不能为空' } });
    }
    if (!assetName) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '素材名称不能为空' } });
    }
    if (!assetType || !['image', 'video', 'audio'].includes(assetType)) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '素材类型必须是 image/video/audio' } });
    }
    if (!assetUrl) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '素材文件 URL 不能为空' } });
    }

    try {
      const { ak, sk } = await loadAksk();

      const reqBody: Record<string, any> = {
        AssetGroupId: assetGroupId,
        AssetName: assetName,
        AssetType: assetType,
        SourceUrl: assetUrl,
      };
      if (description) reqBody.Description = description;

      const resp = await signedRequest(ak, sk, {
        method: 'POST',
        host: VOLC_OPENAPI_HOST,
        path: '/',
        query: 'Action=CreateAsset&Version=2024-01-01',
        body: reqBody,
        service: 'ark',
      });

      const data = await resp.json() as any;

      // 记录到本地数据库
      if (data.Response?.Result?.AssetId) {
        // 保存素材记录到系统设置或日志
      }

      if (!resp.ok) {
        return reply.status(resp.status).send({
          success: false,
          error: {
            code: 'ASSET_CREATE_FAILED',
            message: data.Response?.Error?.Message || data.ResponseMetadata?.Error?.Message || `HTTP ${resp.status}`,
          },
        });
      }

      return {
        success: true,
        data: {
          assetId: data.Response?.Result?.AssetId,
          status: data.Response?.Result?.Status,
          createTime: data.Response?.Result?.CreateTime,
        },
        message: '素材上传成功，等待处理完成',
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'ASSET_CREATE_FAILED', message: (err as Error).message },
      });
    }
  });

  // ── 查询素材状态 ──
  app.get('/api/v1/assets/:assetId', { preHandler: [adminAuth] }, async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    try {
      const { ak, sk } = await loadAksk();

      const resp = await signedRequest(ak, sk, {
        method: 'POST',
        host: VOLC_OPENAPI_HOST,
        path: '/',
        query: 'Action=GetAsset&Version=2024-01-01',
        body: { AssetId: assetId },
        service: 'ark',
      });

      const data = await resp.json() as any;

      if (!resp.ok) {
        return reply.status(resp.status).send({
          success: false,
          error: {
            code: 'ASSET_QUERY_FAILED',
            message: data.Response?.Error?.Message || data.ResponseMetadata?.Error?.Message || `HTTP ${resp.status}`,
          },
        });
      }

      return {
        success: true,
        data: {
          assetId: data.Response?.Result?.AssetId,
          assetName: data.Response?.Result?.AssetName,
          assetType: data.Response?.Result?.AssetType,
          status: data.Response?.Result?.Status,
          sourceUrl: data.Response?.Result?.SourceUrl,
          errorMsg: data.Response?.Result?.ErrorMessage,
        },
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'ASSET_QUERY_FAILED', message: (err as Error).message },
      });
    }
  });
}

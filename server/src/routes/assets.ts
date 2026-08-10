/**
 * 素材管理路由 — 火山引擎素材库
 *
 * 鉴权：apiKeyAuth（用户通过 AI Studio 的 API Key 访问）
 *
 * 每个请求都必须带 ProjectName（与 API Key 所属项目一致）
 *
 * 素材入库流程：
 *   1. AI Studio 上传文件到 uguu.se → 拿到 httpUrl
 *   2. POST /api/v1/assets/create → MaaS → 火山 CreateAsset
 *   3. AI Studio 轮询 GET /api/v1/assets/:assetId → 直到 Status = "active"
 *   4. 用户可在 AI Studio 中查看/删除素材
 */

import { FastifyInstance } from 'fastify';
import { apiKeyAuth } from '../middleware/auth';
import { loadAksk } from '../services/volcano';
import { signedRequest } from '../services/volcano-signature';
import prisma from '../config/database';

const VOLC_HOST = 'open.volcengineapi.com';
// 项目名从系统配置读取，loadAksk() 会一并返回

/**
 * 按用户自动创建或复用素材组
 * 每个用户一个素材组，第一次上传时自动创建，后续复用
 */
async function ensureAssetGroup(userId: number, ak: string, sk: string, projectName: string): Promise<string> {
  // 查本地缓存
  const existing = await prisma.assetGroup.findUnique({ where: { userId } });
  if (existing) return existing.volcGroupId;

  // 调火山 CreateAssetGroup
  const groupName = `maas-user-${userId}`;
  const resp = await signedRequest(ak, sk, {
    method: 'POST',
    host: VOLC_HOST,
    path: '/',
    query: 'Action=CreateAssetGroup&Version=2024-01-01',
    body: { Name: groupName, Description: 'MaaS 自动创建', GroupType: 'AIGC', ProjectName: projectName },
    service: 'ark',
  });

  const data = await resp.json() as any;
  const groupId = data?.Result?.Id || data?.Response?.Result?.Id;
  if (!groupId) {
    const errMsg = data?.ResponseMetadata?.Error?.Message || data?.Response?.Error?.Message || '创建素材组失败';
    throw new Error(errMsg);
  }

  // 存本地
  await prisma.assetGroup.create({
    data: { userId, volcGroupId: groupId },
  });

  return groupId;
}

export default async function assetRoutes(app: FastifyInstance) {
  // ── POST /api/v1/assets/create — 上传素材 ──
  app.post('/api/v1/assets/create', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const body = request.body as Record<string, any>;
    const { assetName, assetType, assetUrl } = body || {};

    if (!assetName) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '素材名称不能为空' } });
    }
    if (!assetType || !['image', 'video', 'audio'].includes(assetType)) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '素材类型必须是 image/video/audio' } });
    }
    if (!assetUrl) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '素材文件 URL 不能为空' } });
    }

    const userId = request.apiKeyUserId!;

    try {
      const { ak, sk, projectName } = await loadAksk();

      // 1. 确保有素材组
      const groupId = await ensureAssetGroup(userId, ak, sk, projectName);

      // 2. 调火山 CreateAsset
      const reqBody: Record<string, any> = {
        GroupId: groupId,
        Name: assetName,
        AssetType: assetType.charAt(0).toUpperCase() + assetType.slice(1),
        URL: assetUrl,
        ProjectName: projectName,
      };

      const resp = await signedRequest(ak, sk, {
        method: 'POST',
        host: VOLC_HOST,
        path: '/',
        query: 'Action=CreateAsset&Version=2024-01-01',
        body: reqBody,
        service: 'ark',
      });

      const data = await resp.json() as any;

      if (!resp.ok) {
        const errMsg = data?.ResponseMetadata?.Error?.Message || data?.Response?.Error?.Message || `HTTP ${resp.status}`;
        return reply.status(resp.status).send({
          success: false,
          error: { code: 'ASSET_CREATE_FAILED', message: errMsg },
        });
      }

      const volcAssetId: string = data?.Result?.Id || data?.Response?.Result?.Id;
      const volcStatus: string = (data?.Result?.Status || data?.Response?.Result?.Status || 'Processing').toLowerCase();

      // 3. 存本地记录
      await prisma.asset.create({
        data: {
          userId,
          assetName,
          assetType,
          sourceUrl: assetUrl,
          volcAssetId,
          volcStatus,
        },
      });

      return {
        success: true,
        data: {
          id: volcAssetId,
          name: assetName,
          type: assetType,
          url: assetUrl,
          status: volcStatus,
        },
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'ASSET_CREATE_FAILED', message: (err as Error).message },
      });
    }
  });

  // ── GET /api/v1/assets/:assetId — 查询素材状态 ──
  app.get('/api/v1/assets/:assetId', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const userId = request.apiKeyUserId!;

    try {
      // 先查本地
      const local = await prisma.asset.findUnique({
        where: { volcAssetId: assetId },
      });

      if (!local || local.userId !== userId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: '素材不存在' },
        });
      }

      // 如果已经是终态，直接返回
      if (local.volcStatus === 'active' || local.volcStatus === 'failed') {
        return {
          success: true,
          data: {
            id: local.volcAssetId,
            name: local.assetName,
            type: local.assetType,
            url: local.sourceUrl,
            status: local.volcStatus,
            errorMessage: local.errorMessage,
          },
        };
      }

      // 调火山 GetAsset 获取最新状态
      const { ak, sk, projectName } = await loadAksk();
      const resp = await signedRequest(ak, sk, {
        method: 'POST',
        host: VOLC_HOST,
        path: '/',
        query: 'Action=GetAsset&Version=2024-01-01',
        body: { Id: assetId, ProjectName: projectName },
        service: 'ark',
      });

      const data = await resp.json() as any;

      if (resp.ok && data.Response?.Result) {
        const result = data.Response.Result;
        const newStatus = result.Status || local.volcStatus;
        const errorMsg = result.ErrorMessage || null;

        // 更新本地状态
        await prisma.asset.update({
          where: { volcAssetId: assetId },
          data: { volcStatus: newStatus, errorMessage: errorMsg },
        });

        return {
          success: true,
          data: {
            id: assetId,
            name: result.Name || local.assetName,
            type: result.AssetType || local.assetType,
            url: result.URL || local.sourceUrl,
            status: newStatus,
            errorMessage: errorMsg,
          },
        };
      }

      // 火山返回错误，不更新本地状态，返回当前状态
      return {
        success: true,
        data: {
          id: local.volcAssetId,
          name: local.assetName,
          type: local.assetType,
          url: local.sourceUrl,
          status: local.volcStatus,
          errorMessage: local.errorMessage,
        },
      };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'ASSET_QUERY_FAILED', message: (err as Error).message },
      });
    }
  });

  // ── GET /api/v1/assets — 列出当前用户的素材 ──
  app.get('/api/v1/assets', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const userId = request.apiKeyUserId!;
    const assets = await prisma.asset.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      data: assets.map(a => ({
        id: a.volcAssetId || `local-${a.id}`,
        name: a.assetName,
        type: a.assetType,
        url: a.sourceUrl,
        status: a.volcStatus,
        errorMessage: a.errorMessage,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });

  // ── DELETE /api/v1/assets/:assetId — 删除素材 ──
  app.delete('/api/v1/assets/:assetId', { preHandler: [apiKeyAuth] }, async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const userId = request.apiKeyUserId!;

    try {
      const local = await prisma.asset.findUnique({
        where: { volcAssetId: assetId },
      });

      if (!local || local.userId !== userId) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: '素材不存在' },
        });
      }

      // 调火山 DeleteAsset
      const { ak, sk, projectName } = await loadAksk();
      const resp = await signedRequest(ak, sk, {
        method: 'POST',
        host: VOLC_HOST,
        path: '/',
        query: 'Action=DeleteAsset&Version=2024-01-01',
        body: { Id: assetId, ProjectName: projectName },
        service: 'ark',
      });

      const data = await resp.json() as any;

      if (!resp.ok) {
        const errMsg = data?.ResponseMetadata?.Error?.Message || data?.Response?.Error?.Message || `HTTP ${resp.status}`;
        // 404 说明火山侧已删除，本地点直接删
        if (resp.status !== 404) {
          return reply.status(resp.status).send({
            success: false,
            error: { code: 'ASSET_DELETE_FAILED', message: errMsg },
          });
        }
      }

      // 删除本地记录
      await prisma.asset.delete({ where: { id: local.id } });

      return { success: true, message: '素材已删除' };
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: { code: 'ASSET_DELETE_FAILED', message: (err as Error).message },
      });
    }
  });
}

import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { adminAuth } from '../middleware/auth';
import { allocateQuotaSchema, modelActionSchema } from '../utils/validators';
import { decryptApiKey } from '../utils/apiKey';
import { syncModels } from '../services/model-sync';

export default async function adminRoutes(app: FastifyInstance) {
  // ========== 大屏总览 ==========
  app.get('/api/v1/admin/overview', { preHandler: [adminAuth] }, async (request, reply) => {
    const [
      totalUsers, totalKeys, activeKeys,
      onlineModels, offlineModels, totalCalls,
      todayCalls, totalQuotaUsed,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.apiKey.count(),
      prisma.apiKey.count({ where: { status: 'active' } }),
      prisma.model.count({ where: { status: 'online' } }),
      prisma.model.count({ where: { status: 'offline' } }),
      prisma.callLog.count(),
      prisma.callLog.count({ where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
      prisma.apiKey.aggregate({ _sum: { quotaUsed: true } }),
    ]);

    // 各模型调用占比（按调用量降序）
    const modelCalls = await prisma.callLog.groupBy({
      by: ['modelId'],
      _count: true,
      orderBy: { _count: { modelId: 'desc' } },
    });
    const models = await prisma.model.findMany({ select: { id: true, name: true } });
    const modelNameMap = new Map(models.map(m => [m.id, m.name]));

    return {
      success: true,
      data: {
        users: { total: totalUsers },
        keys: { total: totalKeys, active: activeKeys },
        models: { online: onlineModels, offline: offlineModels, total: onlineModels + offlineModels },
        calls: { total: totalCalls, today: todayCalls },
        quota: { totalUsed: Number(totalQuotaUsed._sum.quotaUsed) || 0 },
        modelDistribution: modelCalls.map(m => ({
          model: modelNameMap.get(m.modelId!) || '未知',
          count: m._count,
        })),
      },
    };
  });

  // ========== 用户管理 ==========
  app.get('/api/v1/admin/users', { preHandler: [adminAuth] }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; search?: string };
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '20');
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { username: { contains: query.search } },
        { email: { contains: query.search } },
        { phone: { contains: query.search } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, username: true, email: true, phone: true, role: true, isActive: true, createdAt: true },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    return { success: true, data: { items: users, total, page, limit } };
  });

  // 启用/禁用用户
  app.put('/api/v1/admin/users/:id/toggle', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const user = await prisma.user.findUnique({ where: { id: parseInt(id) } });
    if (!user) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '用户不存在' } });
    await prisma.user.update({ where: { id: parseInt(id) }, data: { isActive: !user.isActive } });
    return { success: true, message: user.isActive ? '用户已禁用' : '用户已启用' };
  });

  app.put('/api/v1/admin/users/:id', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as { isActive?: boolean; role?: string };
    await prisma.user.update({ where: { id: parseInt(id) }, data: body });
    return { success: true, message: '用户信息已更新' };
  });

  // ========== Key 管理 ==========
  app.get('/api/v1/admin/keys', { preHandler: [adminAuth] }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string };
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '20');

    const [keys, total] = await Promise.all([
      prisma.apiKey.findMany({
        select: {
          id: true, keyName: true, status: true, quotaTotal: true, quotaUsed: true,
          lastUsed: true, createdAt: true,
          user: { select: { id: true, username: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.apiKey.count(),
    ]);

    return { success: true, data: { items: keys, total, page, limit } };
  });

  // 分配配额
  app.put('/api/v1/admin/keys/:id/quota', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as Record<string, unknown>;
    const parsed = allocateQuotaSchema.safeParse({ ...body, keyId: parseInt(id) });
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || "参数错误" } });
    }

    const { amount, reason, description } = parsed.data;
    const key = await prisma.apiKey.findUnique({ where: { id: parseInt(id) } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });

    await Promise.all([
      prisma.apiKey.update({
        where: { id: parseInt(id) },
        data: {
          quotaTotal: { increment: amount },
          status: 'active', // 分配额度后自动激活
        },
      }),
      prisma.keyQuotaHistory.create({
        data: {
          keyId: parseInt(id),
          amount,
          reason: reason || 'manual',
          allocatedBy: request.user!.userId,
          description,
        },
      }),
    ]);

    return { success: true, message: `已分配 ${amount} 算力额度` };
  });

  // 启用/禁用 Key
  app.put('/api/v1/admin/keys/:id/toggle', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const key = await prisma.apiKey.findUnique({ where: { id: parseInt(id) } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });
    const newStatus = key.status === 'revoked' ? 'active' : 'revoked';
    await prisma.apiKey.update({ where: { id: parseInt(id) }, data: { status: newStatus } });
    return { success: true, message: newStatus === 'active' ? 'Key 已启用' : 'Key 已禁用' };
  });

  // 删除 Key（硬删失败则软删除）
  app.delete('/api/v1/admin/keys/:id', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    try {
      await prisma.apiKey.delete({ where: { id: parseInt(id) } });
    } catch (err: any) {
      if (err?.code === 'P2003' || err?.code === 'P2014' || err?.message?.includes('Foreign key')) {
        await prisma.apiKey.update({ where: { id: parseInt(id) }, data: { status: 'revoked', keyName: { set: String(id) + '（已删除）' } } });
        return { success: true, message: 'Key 已软删除（历史调用日志保留）' };
      }
      if (err?.code === 'P2025') {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });
      }
      throw err;
    }
    return { success: true, message: 'Key 已删除' };
  });

  // 查看 Key 明文
  app.get('/api/v1/admin/keys/:id/value', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const key = await prisma.apiKey.findUnique({ where: { id: parseInt(id) } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });
    const plain = decryptApiKey(key.keyValue);
    return { success: true, data: { keyValue: plain } };
  });

  // ========== 模型管理 ==========
  app.get('/api/v1/admin/models/status', { preHandler: [adminAuth] }, async (request, reply) => {
    const models = await prisma.model.findMany({ orderBy: { createdAt: 'asc' } });
    return { success: true, data: models };
  });

  // 加载模型
  app.post('/api/v1/admin/models/load', { preHandler: [adminAuth] }, async (request, reply) => {
    const parsed = modelActionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || "参数错误" } });
    }
    const model = await prisma.model.findUnique({ where: { name: parsed.data.modelName } });
    if (!model) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '模型不存在' } });

    // 火山引擎模型直接上架，自部署模型标记为 loading
    if (model.source === 'volcano') {
      await prisma.model.update({
        where: { name: parsed.data.modelName },
        data: { status: 'online', isHot: true, loadTime: new Date() },
      });
      return { success: true, message: '模型已上线' };
    }
    await prisma.model.update({
      where: { name: parsed.data.modelName },
      data: { status: 'loading', isHot: true, loadTime: new Date() },
    });
    return { success: true, message: '自部署模型请手动启动进程后标记状态' };
  });

  // 卸载模型
  app.post('/api/v1/admin/models/unload', { preHandler: [adminAuth] }, async (request, reply) => {
    const parsed = modelActionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || '参数错误' } });
    }
    const model = await prisma.model.findUnique({ where: { name: parsed.data.modelName } });
    if (!model) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '模型不存在' } });
    await prisma.model.update({
      where: { name: parsed.data.modelName },
      data: { status: 'offline', isHot: false },
    });
    return { success: true, message: model.source.startsWith('volcano') ? '模型已下线' : '模型已卸载' };
  });

  // 手动触发模型同步（扫描 Ollama/vLLM 等自部署后端）
  app.post('/api/v1/admin/models/sync', { preHandler: [adminAuth] }, async (request, reply) => {
    try {
      const result = await syncModels({
        ollamaEndpoints: ['http://localhost:11434'],
        vllmEndpoints: [],
      });
      return { success: true, data: result, message: `检测 ${result.detected} 个模型，注册 ${result.registered}，更新 ${result.updated}，下线 ${result.offlined}` };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { code: 'SYNC_FAILED', message: (err as Error).message } });
    }
  });

  // ========== 调用日志 ==========
  app.get('/api/v1/admin/logs', { preHandler: [adminAuth] }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; userId?: string; modelId?: string; status?: string; startDate?: string; endDate?: string };
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '20');

    const where: any = {};
    if (query.userId) where.userId = parseInt(query.userId);
    if (query.modelId) where.modelId = parseInt(query.modelId);
    if (query.status) where.status = query.status;
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) where.createdAt.lte = new Date(query.endDate);
    }

    const [logs, total] = await Promise.all([
      prisma.callLog.findMany({
        where,
        select: {
          id: true, apiKeyId: true, userId: true, modelId: true,
          tokensInput: true, tokensOutput: true, durationMs: true, cost: true,
          status: true, createdAt: true,
          user: { select: { username: true } },
          model: { select: { name: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.callLog.count({ where }),
    ]);

    return { success: true, data: { items: logs, total, page, limit } };
  });
}
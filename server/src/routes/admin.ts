import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { adminAuth } from '../middleware/auth';
import { allocateQuotaSchema, modelActionSchema } from '../utils/validators';
import { decryptApiKey } from '../utils/apiKey';
import { config } from '../config';
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
          quotaTotal: amount,
          status: 'active',
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

  // 手动触发模型同步（扫描 Ollama/vLLM/Diffusers + 火山引擎等所有后端）
  app.post('/api/v1/admin/models/sync', { preHandler: [adminAuth] }, async (request, reply) => {
    try {
      const result = await syncModels({
        ollamaEndpoints: config.sync.ollamaEndpoints,
        vllmEndpoints: config.sync.vllmEndpoints,
        diffusersEndpoints: config.sync.diffusersEndpoints,
        includeVolcano: true,
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

    return { success: true, data: { items: logs.map((l: any) => ({ ...l, id: Number(l.id) })), total, page, limit } };
  });

  // ========== 账单核对 ==========

  // 模型维度账单（每次调用明细 + 汇总）
  app.get('/api/v1/admin/billing/models', { preHandler: [adminAuth] }, async (request, reply) => {
    const query = request.query as { startDate?: string; endDate?: string; page?: string; limit?: string; search?: string; source?: string };
    const startDate = query.startDate ? new Date(query.startDate) : new Date(0);
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '50');

    const where: any = {
      status: 'success',
      createdAt: { gte: startDate, lte: endDate },
    };

    // 来源筛选
    if (query.source === 'volcano' || query.source === 'local') {
      where.model = { source: query.source };
    }

    // 搜索：模糊匹配用户名或模型名
    if (query.search) {
      where.OR = [
        { user: { username: { contains: query.search, mode: 'insensitive' } } },
        { model: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.callLog.findMany({
        where,
        include: {
          user: { select: { id: true, username: true } },
          model: { select: { name: true, source: true, modelType: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.callLog.count({ where }),
    ]);

    // 汇总（按 source 分组 + 总计）
    const sourceMap = new Map<string, { cost: number; calls: number }>();
    let totalCostFull = 0, totalCallsFull = 0;
    for (const l of logs) {
      const src = l.model?.source || 'unknown';
      const cost = Number(l.cost || 0);
      if (!sourceMap.has(src)) sourceMap.set(src, { cost: 0, calls: 0 });
      const entry = sourceMap.get(src)!;
      entry.cost += cost;
      entry.calls++;
      totalCostFull += cost;
      totalCallsFull++;
    }
    for (const [k, v] of sourceMap) {
      v.cost = Math.round(v.cost * 10000) / 10000;
    }
    totalCostFull = Math.round(totalCostFull * 10000) / 10000;

    const summary = {
      volcanoCost: sourceMap.get('volcano')?.cost || 0,
      volcanoCalls: sourceMap.get('volcano')?.calls || 0,
      localCost: sourceMap.get('local')?.cost || 0,
      localCalls: sourceMap.get('local')?.calls || 0,
    };

    // 按 source 分组
    const groups: { source: string; cost: number; calls: number }[] = [];
    for (const [src, v] of sourceMap) {
      groups.push({ source: src, cost: v.cost, calls: v.calls });
    }
    groups.sort((a, b) => b.cost - a.cost);

    return {
      success: true,
      data: {
        period: { startDate: query.startDate || 'all', endDate: query.endDate || 'now' },
        summary,
        groups,
        items: logs.map((l: any) => ({
          id: Number(l.id),
          user: l.user?.username || '—',
          model: l.model?.name || '—',
          source: l.model?.source || 'unknown',
          modelType: l.model?.modelType || '—',
          tokensInput: l.tokensInput || 0,
          tokensOutput: l.tokensOutput || 0,
          durationMs: l.durationMs,
          cost: Number(l.cost || 0),
          status: l.status,
          createdAt: l.createdAt,
        })),
        totalCost: totalCostFull,
        totalCalls: totalCallsFull,
        total,
        page,
        limit,
      },
    };
  });

  // 用户维度账单（每次调用明细 + 汇总）
  app.get('/api/v1/admin/billing/users', { preHandler: [adminAuth] }, async (request, reply) => {
    const query = request.query as { userId?: string; startDate?: string; endDate?: string; page?: string; limit?: string; search?: string; source?: string };
    const startDate = query.startDate ? new Date(query.startDate) : new Date(0);
    const endDate = query.endDate ? new Date(query.endDate) : new Date();
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '50');

    const where: any = {
      status: 'success',
      createdAt: { gte: startDate, lte: endDate },
    };
    if (query.userId) where.userId = parseInt(query.userId);

    if (query.source === 'volcano' || query.source === 'local') {
      where.model = { source: query.source };
    }

    if (query.search) {
      where.OR = [
        { user: { username: { contains: query.search, mode: 'insensitive' } } },
        { model: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.callLog.findMany({
        where,
        include: {
          user: { select: { id: true, username: true } },
          model: { select: { name: true, source: true, modelType: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.callLog.count({ where }),
    ]);

    // 按用户汇总
    const userSummaryMap = new Map<number, {
      username: string; volcanoCost: number; volcanoCalls: number; localCost: number; localCalls: number;
    }>();

    for (const l of logs) {
      const uid = l.userId || 0;
      if (!userSummaryMap.has(uid)) {
        userSummaryMap.set(uid, { username: l.user?.username || '?', volcanoCost: 0, volcanoCalls: 0, localCost: 0, localCalls: 0 });
      }
      const entry = userSummaryMap.get(uid)!;
      const cost = Number(l.cost || 0);
      if (l.model?.source === 'volcano') { entry.volcanoCost += cost; entry.volcanoCalls++; }
      else { entry.localCost += cost; entry.localCalls++; }
    }

    const totalVolcano = Math.round([...userSummaryMap.values()].reduce((s, e) => s + e.volcanoCost, 0) * 10000) / 10000;
    const totalLocal = Math.round([...userSummaryMap.values()].reduce((s, e) => s + e.localCost, 0) * 10000) / 10000;

    return {
      success: true,
      data: {
        period: { startDate: query.startDate || 'all', endDate: query.endDate || 'now' },
        summary: {
          volcanoCost: totalVolcano, volcanoCalls: [...userSummaryMap.values()].reduce((s, e) => s + e.volcanoCalls, 0),
          localCost: totalLocal, localCalls: [...userSummaryMap.values()].reduce((s, e) => s + e.localCalls, 0),
        },
        items: logs.map((l: any) => ({
          id: Number(l.id),
          userId: l.userId,
          user: l.user?.username || '—',
          model: l.model?.name || '—',
          source: l.model?.source || 'unknown',
          modelType: l.model?.modelType || '—',
          tokensInput: l.tokensInput || 0,
          tokensOutput: l.tokensOutput || 0,
          durationMs: l.durationMs,
          cost: Number(l.cost || 0),
          status: l.status,
          createdAt: l.createdAt,
        })),
        total,
        page,
        limit,
      },
    };
  });
}
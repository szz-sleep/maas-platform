import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { adminAuth } from '../middleware/auth';
import { allocateQuotaSchema, modelActionSchema } from '../utils/validators';
import { decryptApiKey } from '../utils/apiKey';
import { config } from '../config';
import { syncModels } from '../services/model-sync';

/** 把值转成数字或 null（空串/undefined/null → null） */
function numOrNull(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function adminRoutes(app: FastifyInstance) {
  // ========== 大屏总览 ==========
  app.get('/api/v1/admin/overview', { preHandler: [adminAuth] }, async (request, reply) => {
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(parseInt(query.days || '7') || 7, 1), 30);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const [
      totalUsers, totalKeys, activeKeys,
      onlineModels, offlineModels, totalCalls,
      totalQuotaUsed,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.apiKey.count(),
      prisma.apiKey.count({ where: { status: 'active' } }),
      prisma.model.count({ where: { status: 'online' } }),
      prisma.model.count({ where: { status: 'offline' } }),
      prisma.callLog.count(),
      prisma.apiKey.aggregate({ _sum: { quotaUsed: true } }),
    ]);

    // 今日调用
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayCalls = await prisma.callLog.count({ where: { createdAt: { gte: todayStart } } });

    // 各模型调用占比（按调用量降序）
    const modelCalls = await prisma.callLog.groupBy({ by: ['modelId'], _count: true, orderBy: { _count: { modelId: 'desc' } } });
    const models = await prisma.model.findMany({ select: { id: true, name: true, modelType: true, source: true } });
    const modelNameMap = new Map(models.map(m => [m.id, m]));

    // 近 days 天：按天调用量 + 按天费用消耗（用于趋势图）
    const dayCallsRaw = await prisma.callLog.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, cost: true } });
    const dayMap = new Map<string, { calls: number; cost: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - i);
      dayMap.set(d.toISOString().slice(0,10), { calls: 0, cost: 0 });
    }
    for (const c of dayCallsRaw) {
      const key = new Date(c.createdAt).toISOString().slice(0,10);
      if (dayMap.has(key)) {
        dayMap.get(key)!.calls++;
        dayMap.get(key)!.cost += Number(c.cost || 0);
      }
    }
    const callTrend = Array.from(dayMap.entries()).map(([date, v]) => ({ date, calls: v.calls, cost: Math.round(v.cost*1000)/1000 }));

    // 按模型类型分布（video/image/chat/... 的调用量）
    const typeCount: Record<string, number> = {};
    const typeCost: Record<string, number> = {};
    for (const mc of modelCalls) {
      const m = modelNameMap.get(mc.modelId!);
      const t = m?.modelType || 'unknown';
      typeCount[t] = (typeCount[t] || 0) + mc._count;
    }
    // 费用按类型（从 dayCallsRaw 不好分类型，改用聚合并关联模型）
    const costByModel = await prisma.callLog.groupBy({ by: ['modelId'], _sum: { cost: true }, where: { createdAt: { gte: since } } });
    for (const c of costByModel) {
      const m = modelNameMap.get(c.modelId!);
      const t = m?.modelType || 'unknown';
      typeCost[t] = (typeCost[t] || 0) + Number(c._sum.cost || 0);
    }
    const typeDistribution = Object.keys({ ...typeCount, ...typeCost }).map(t => ({
      type: t,
      calls: typeCount[t] || 0,
      cost: Math.round((typeCost[t] || 0) * 1000) / 1000,
    })).sort((a, b) => b.calls - a.calls);

    // 用户 TOP（按调用次数）
    const userCalls = await prisma.callLog.groupBy({ by: ['userId'], _count: true, _sum: { cost: true }, orderBy: { _count: { userId: 'desc' } }, take: 10 });
    const userMedoids = await prisma.user.findMany({ where: { id: { in: userCalls.map(u=>u.userId!).filter(Boolean) } }, select: { id: true, username: true } });
    const userMap = new Map(userMedoids.map(u => [u.id, u.username]));
    const topUsers = userCalls.map(u => ({
      userId: u.userId, username: userMap.get(u.userId!) || '已删除用户',
      calls: u._count, cost: Math.round(Number(u._sum.cost || 0) * 1000) / 1000,
    }));

    // 最近调用
    const recentLogs = await prisma.callLog.findMany({
      orderBy: { createdAt: 'desc' }, take: 10,
      include: { user: { select: { username: true } }, model: { select: { name: true, source: true, modelType: true } } },
    });

    return {
      success: true,
      data: {
        days,
        users: { total: totalUsers },
        keys: { total: totalKeys, active: activeKeys },
        models: { online: onlineModels, offline: offlineModels, total: onlineModels + offlineModels },
        calls: { total: totalCalls, today: todayCalls },
        quota: { totalUsed: Number(totalQuotaUsed._sum.quotaUsed) || 0 },
        modelDistribution: modelCalls.map(m => ({
          model: modelNameMap.get(m.modelId!)?.name || '未知',
          count: m._count,
        })).slice(0, 10),
        callTrend,
        typeDistribution,
        topUsers,
        recentLogs: recentLogs.map((l: any) => ({
          id: Number(l.id), user: l.user?.username || '—',
          model: l.model?.name || '—', source: l.model?.source || 'unknown',
          modelType: l.model?.modelType || '—',
          cost: Number(l.cost || 0), status: l.status, createdAt: l.createdAt,
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

  /** 删除单个或多个用户（级联删其 Key/素材；调用日志 SetNull 保留） */
  async function deleteUsers(ids: number[], operatorId: number | undefined) {
    // 过滤：不能删除管理员，也不能删除操作者本人
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, role: true } });
    const blocked: number[] = [];
    const validIds = users.filter(u => {
      if (u.role === 'admin' || u.id === operatorId) { blocked.push(u.id); return false; }
      return true;
    }).map(u => u.id);

    if (validIds.length > 0) {
      // 先删 Key（cascade 会带 KeyModel），再删用户（Asset/AssetGroup cascade）
      await prisma.apiKey.deleteMany({ where: { userId: { in: validIds } } });
      await prisma.user.deleteMany({ where: { id: { in: validIds } } });
    }
    return { deleted: validIds.length, blocked };
  }

  // 删除单个用户
  app.delete('/api/v1/admin/users/:id', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const user = await prisma.user.findUnique({ where: { id: parseInt(id) }, select: { id: true, role: true } });
    if (!user) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '用户不存在' } });
    if (user.role === 'admin') return reply.status(400).send({ success: false, error: { code: 'FORBIDDEN', message: '不能删除管理员账号' } });
    if (user.id === request.user?.userId) return reply.status(400).send({ success: false, error: { code: 'FORBIDDEN', message: '不能删除当前登录账号' } });

    const result = await deleteUsers([parseInt(id)], request.user?.userId);
    const msg = result.deleted > 0 ? '用户已删除（关联 Key/素材已一并清理，调用日志保留）' : '未删除任何用户';
    return { success: result.deleted > 0, message: msg };
  });

  // 批量删除用户
  app.post('/api/v1/admin/users/batch/delete', { preHandler: [adminAuth] }, async (request, reply) => {
    const body = request.body as { userIds?: number[] };
    const ids = (body.userIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '请至少选择一位用户' } });

    const result = await deleteUsers(ids, request.user?.userId);
    const msg = result.deleted > 0
      ? `已删除 ${result.deleted} 位用户${result.blocked.length ? `（跳过 ${result.blocked.length} 个管理员/本人）` : ''}`
      : (result.blocked.length ? '所选用户均为管理员或操作者本人，无法删除' : '未删除任何用户');
    return { success: true, message: msg, data: result };
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

  // 获取 Key 已允许的模型
  app.get('/api/v1/admin/keys/:id/models', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const key = await prisma.apiKey.findUnique({ where: { id: parseInt(id) } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });
    const keyModels = await prisma.keyModel.findMany({
      where: { apiKeyId: parseInt(id) },
      select: { model: { select: { id: true, name: true, displayName: true, modelType: true, source: true } } },
    });
    return { success: true, data: keyModels.map(km => km.model) };
  });

  // 设置 Key 允许的模型（会覆盖旧的映射；传空数组 = 清空，即该 Key 不可用任何模型）
  app.put('/api/v1/admin/keys/:id/models', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const keyId = parseInt(id);
    const body = request.body as { modelIds?: number[] };
    const modelIds = Array.isArray(body?.modelIds) ? body.modelIds.map(Number).filter(n => Number.isInteger(n)) : [];

    const key = await prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });

    // 校验所有模型都存在
    if (modelIds.length > 0) {
      const count = await prisma.model.count({ where: { id: { in: modelIds } } });
      if (count !== modelIds.length) {
        return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '存在无效的模型 ID' } });
      }
    }

    // 事务：删除旧映射 → 插入新映射
    await prisma.$transaction(async (tx) => {
      await tx.keyModel.deleteMany({ where: { apiKeyId: keyId } });
      if (modelIds.length > 0) {
        await tx.keyModel.createMany({
          data: modelIds.map(modelId => ({ apiKeyId: keyId, modelId })),
          skipDuplicates: true,
        });
      }
    });

    return { success: true, message: modelIds.length > 0 ? `已授权 ${modelIds.length} 个模型` : '已清空该 Key 的模型授权' };
  });

  // 批量给多个 Key 设置可用模型（覆盖式：keyIds 每个 Key 都设为 modelIds）
  app.post('/api/v1/admin/keys/batch/models', { preHandler: [adminAuth] }, async (request, reply) => {
    const body = request.body as { keyIds?: number[]; modelIds?: number[] };
    const keyIds = (body.keyIds || []).map(Number).filter(n => Number.isInteger(n));
    const modelIds = (body.modelIds || []).map(Number).filter(n => Number.isInteger(n));

    if (keyIds.length === 0) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '请选择至少一个 Key' } });
    }

    // 校验所有 Key 存在
    const keyCount = await prisma.apiKey.count({ where: { id: { in: keyIds } } });
    if (keyCount !== keyIds.length) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '存在无效的 Key ID' } });
    }
    // 校验所有模型存在
    if (modelIds.length > 0) {
      const modelCount = await prisma.model.count({ where: { id: { in: modelIds } } });
      if (modelCount !== modelIds.length) {
        return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '存在无效的模型 ID' } });
      }
    }

    // 事务：对每个 Key 删旧 + 插新（覆盖式）
    await prisma.$transaction(async (tx) => {
      for (const keyId of keyIds) {
        await tx.keyModel.deleteMany({ where: { apiKeyId: keyId } });
        if (modelIds.length > 0) {
          await tx.keyModel.createMany({
            data: modelIds.map(modelId => ({ apiKeyId: keyId, modelId })),
            skipDuplicates: true,
          });
        }
      }
    });

    return { success: true, message: `已为 ${keyIds.length} 个 Key 批量设置 ${modelIds.length} 个模型` };
  });

  // 批量给多个 Key 设置配额（覆盖式：每个 Key 都设为 amount）
  app.post('/api/v1/admin/keys/batch/quota', { preHandler: [adminAuth] }, async (request, reply) => {
    const body = request.body as { keyIds?: number[]; amount?: number; reason?: string; description?: string };
    const keyIds = (body.keyIds || []).map(Number).filter(n => Number.isInteger(n));
    const amount = Number(body.amount);

    if (keyIds.length === 0) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '请选择至少一个 Key' } });
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '请输入有效额度' } });
    }

    const keyCount = await prisma.apiKey.count({ where: { id: { in: keyIds } } });
    if (keyCount !== keyIds.length) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '存在无效的 Key ID' } });
    }

    const reason = body.reason || 'manual';
    const description = body.description || null;
    const adminId = request.user!.userId;

    // 事务：更新所有 Key 额度 + 写配额历史
    await prisma.$transaction(async (tx) => {
      await tx.apiKey.updateMany({
        where: { id: { in: keyIds } },
        data: { quotaTotal: amount, status: 'active' },
      });
      await tx.keyQuotaHistory.createMany({
        data: keyIds.map(keyId => ({ keyId, amount, reason, allocatedBy: adminId, description })),
        skipDuplicates: false,
      });
    });

    return { success: true, message: `已为 ${keyIds.length} 个 Key 批量设置 ${amount} 额度` };
  });

  // ========== 价格管理 ==========
  // 价格表列表
  app.get('/api/v1/admin/prices', { preHandler: [adminAuth] }, async (request, reply) => {
    const prices = await prisma.modelPrice.findMany({ orderBy: [{ modelType: 'asc' }, { resolution: 'asc' }, { modelKey: 'asc' }] });
    return { success: true, data: prices };
  });

  // 更新单个价格项
  app.put('/api/v1/admin/prices/:id', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as any;
    const pid = parseInt(id);
    const existing = await prisma.modelPrice.findUnique({ where: { id: pid } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '价格项不存在' } });

    const upd: any = {};
    if (body.displayName !== undefined) upd.displayName = body.displayName;
    if (body.priceMode !== undefined) upd.priceMode = body.priceMode;
    if (body.inputPrice !== undefined) upd.inputPrice = numOrNull(body.inputPrice);
    if (body.outputPrice !== undefined) upd.outputPrice = numOrNull(body.outputPrice);
    if (body.cacheHitPrice !== undefined) upd.cacheHitPrice = numOrNull(body.cacheHitPrice);
    if (body.inputNoVideo !== undefined) upd.inputNoVideo = numOrNull(body.inputNoVideo);
    if (body.inputWithVideo !== undefined) upd.inputWithVideo = numOrNull(body.inputWithVideo);
    if (body.perSecond !== undefined) upd.perSecond = numOrNull(body.perSecond);
    if (body.perImage !== undefined) upd.perImage = numOrNull(body.perImage);
    if (body.perImageHigh !== undefined) upd.perImageHigh = numOrNull(body.perImageHigh);
    if (body.refModel !== undefined) upd.refModel = body.refModel || null;
    if (body.remark !== undefined) upd.remark = body.remark || null;

    await prisma.modelPrice.update({ where: { id: pid }, data: upd });
    return { success: true, message: '价格已更新' };
  });

  // 新增价格项
  app.post('/api/v1/admin/prices', { preHandler: [adminAuth] }, async (request, reply) => {
    const body = request.body as any;
    if (!body?.modelKey) return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'modelKey 必填' } });
    const data: any = {
      modelKey: body.modelKey,
      displayName: body.displayName || null,
      modelType: body.modelType || 'chat',
      source: body.source || 'volcano',
      priceMode: body.priceMode || 'token',
      inputPrice: numOrNull(body.inputPrice),
      outputPrice: numOrNull(body.outputPrice),
      cacheHitPrice: numOrNull(body.cacheHitPrice),
      resolution: body.resolution || null,
      inputNoVideo: numOrNull(body.inputNoVideo),
      inputWithVideo: numOrNull(body.inputWithVideo),
      perSecond: numOrNull(body.perSecond),
      perImage: numOrNull(body.perImage),
      perImageHigh: numOrNull(body.perImageHigh),
      refModel: body.refModel || null,
      remark: body.remark || null,
    };
    try {
      await prisma.modelPrice.create({ data });
    } catch (err: any) {
      if (err?.code === 'P2002') return reply.status(400).send({ success: false, error: { code: 'DUPLICATE', message: '该 modelKey 已存在' } });
      throw err;
    }
    return { success: true, message: '价格项已添加' };
  });

  // 删除价格项
  app.delete('/api/v1/admin/prices/:id', { preHandler: [adminAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.modelPrice.delete({ where: { id: parseInt(id) } }).catch((err: any) => {
      if (err?.code === 'P2025') return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '价格项不存在' } });
      throw err;
    });
    return { success: true, message: '价格项已删除' };
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
      return { success: true, data: result, message: `检测 ${result.detected} 个模型，注册 ${result.registered}，更新 ${result.updated}，移除 ${result.removed}` };
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
          unitInfo: true, status: true, createdAt: true,
          user: { select: { username: true } },
          model: { select: { name: true, source: true, modelType: true } },
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
          unitInfo: l.unitInfo || null,
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
          unitInfo: l.unitInfo || null,
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
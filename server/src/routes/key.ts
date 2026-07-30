import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { jwtAuth } from '../middleware/auth';
import { generateApiKeyValue, encryptApiKey, decryptApiKey, sha256 } from '../utils/apiKey';
import { createKeySchema } from '../utils/validators';

export default async function keyRoutes(app: FastifyInstance) {
  // 申请新 Key
  app.post('/api/v1/keys', { preHandler: [jwtAuth] }, async (request, reply) => {
    const parsed = createKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || "参数错误" } });
    }
    const plainKey = generateApiKeyValue();
    const encrypted = encryptApiKey(plainKey);

    const key = await prisma.apiKey.create({
      data: {
        userId: request.user!.userId,
        keyName: parsed.data.keyName,
        keyValue: encrypted,
        keyHash: sha256(plainKey),
        status: 'pending_quota',
      },
    });

    return {
      success: true,
      data: {
        id: key.id,
        keyName: key.keyName,
        keyValue: plainKey, // 仅在创建时返回明文 Key
        status: key.status,
        message: 'Key 创建成功！请妥善保管，之后无法再次查看明文。需管理员分配额度后方可使用。',
      },
    };
  });

  // 获取 Key 列表
  app.get('/api/v1/keys', { preHandler: [jwtAuth] }, async (request, reply) => {
    const keys = await prisma.apiKey.findMany({
      where: { userId: request.user!.userId },
      select: {
        id: true, keyName: true, status: true, quotaTotal: true, quotaUsed: true,
        lastUsed: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: keys };
  });

  // 更新 Key 状态（启用/禁用）
  app.put('/api/v1/keys/:id', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status?: string };

    const key = await prisma.apiKey.findFirst({ where: { id: parseInt(id), userId: request.user!.userId } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });

    // pending_quota 状态的 Key 不允许用户自行设为 active
    if (key.status === 'pending_quota' && status === 'active') {
      return reply.status(400).send({ success: false, error: { code: 'QUOTA_NOT_ALLOCATED', message: 'Key 尚未分配额度，请联系管理员' } });
    }

    await prisma.apiKey.update({ where: { id: parseInt(id) }, data: { status } });
    return { success: true, message: `Key 已${status === 'active' ? '启用' : '禁用'}` };
  });

  // 删除 Key
  // 删除 Key（若有关联日志则软删除）
  app.delete('/api/v1/keys/:id', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const key = await prisma.apiKey.findFirst({ where: { id: parseInt(id), userId: request.user!.userId } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });
    try {
      await prisma.apiKey.delete({ where: { id: parseInt(id) } });
    } catch (err: any) {
      // 有关联调用日志时改为软删除
      if (err?.code === 'P2003' || err?.code === 'P2014') {
        await prisma.apiKey.update({ where: { id: parseInt(id) }, data: { status: 'revoked', keyName: key.keyName + '（已删除）' } });
        return { success: true, message: 'Key 已删除（历史调用日志保留）' };
      }
      throw err;
    }
    return { success: true, message: 'Key 已删除' };
  });

  // 查看 Key 明文（仅自己的 Key）
  app.get('/api/v1/keys/:id/value', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { id } = request.params as any;
    const key = await prisma.apiKey.findFirst({ where: { id: parseInt(id), userId: request.user!.userId } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });
    const plain = decryptApiKey(key.keyValue);
    return { success: true, data: { keyValue: plain } };
  });

  // 获取单 Key 用量统计
  app.get('/api/v1/stats/key-usage/:keyId', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { keyId } = request.params as any;
    const key = await prisma.apiKey.findFirst({ where: { id: parseInt(keyId), userId: request.user!.userId } });
    if (!key) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Key 不存在' } });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [totalCalls, todayCalls] = await Promise.all([
      prisma.callLog.count({ where: { apiKeyId: parseInt(keyId) } }),
      prisma.callLog.count({ where: { apiKeyId: parseInt(keyId), createdAt: { gte: today } } }),
    ]);

    const quotaTotal = Number(key.quotaTotal);
    const quotaUsed = Number(key.quotaUsed);
  return {
      success: true,
      data: {
        keyId: parseInt(keyId),
        quotaTotal,
        quotaUsed,
        remaining: quotaTotal - quotaUsed,
        totalCalls,
        todayCalls,
      },
    };
  });

  // 当前用户所有 Key 用量汇总
  app.get('/api/v1/stats/my-usage', { preHandler: [jwtAuth] }, async (request, reply) => {
    const userId = request.user!.userId;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalCalls, monthCalls, keys] = await Promise.all([
      prisma.callLog.count({ where: { userId } }),
      prisma.callLog.count({ where: { userId, createdAt: { gte: monthStart } } }),
      prisma.apiKey.findMany({ where: { userId }, select: { quotaUsed: true } }),
    ]);

    const totalQuotaUsed = keys.reduce((sum, k) => sum + Number(k.quotaUsed), 0);

    return { success: true, data: { totalCalls, monthCalls, totalQuotaUsed } };
  });
}
import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { getRedis } from '../config/redis';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { jwtAuth } from '../middleware/auth';
import { changePasswordSchema, updateProfileSchema, bindEmailSchema, bindPhoneSchema } from '../utils/validators';

// 验证码校验（与 auth.ts 逻辑一致）
async function verifyCode(type: string, target: string, code: string): Promise<boolean> {
  const key = `verify:${type}:${target}`;
  try {
    const redis = getRedis();
    if (redis) {
      const stored = await redis.get(key);
      if (stored === code) { await redis.del(key); return true; }
      return false;
    }
  } catch {}
  if (!globalThis.__codeStore) return false;
  const stored = globalThis.__codeStore.get(key);
  if (stored && stored.code === code && stored.expires > Date.now()) {
    globalThis.__codeStore.delete(key);
    return true;
  }
  return false;
}

export default async function userRoutes(app: FastifyInstance) {
  // 获取用户信息
  app.get('/api/v1/user/profile', { preHandler: [jwtAuth] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { id: true, username: true, email: true, phone: true, role: true, avatarUrl: true, createdAt: true, updatedAt: true },
    });
    if (!user) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '用户不存在' } });
    return { success: true, data: user };
  });

  // 更新用户信息（用户名/头像）
  app.put('/api/v1/user/profile', { preHandler: [jwtAuth] }, async (request, reply) => {
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || "参数错误" } });
    }
    const user = await prisma.user.update({
      where: { id: request.user!.userId },
      data: parsed.data,
      select: { id: true, username: true, email: true, phone: true, avatarUrl: true },
    });
    return { success: true, data: user };
  });

  // 修改密码
  app.put('/api/v1/user/password', { preHandler: [jwtAuth] }, async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || "参数错误" } });
    }
    const user = await prisma.user.findUnique({ where: { id: request.user!.userId } });
    if (!user || !(await verifyPassword(parsed.data.oldPassword, user.passwordHash))) {
      return reply.status(400).send({ success: false, error: { code: 'WRONG_PASSWORD', message: '旧密码错误' } });
    }
    await prisma.user.update({
      where: { id: request.user!.userId },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    });
    return { success: true, message: '密码修改成功' };
  });

  // 绑定/换绑邮箱
  app.put('/api/v1/user/bind-email', { preHandler: [jwtAuth] }, async (request, reply) => {
    const parsed = bindEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || "参数错误" } });
    }
    const { email, code } = parsed.data;
    // 校验验证码
    const valid = await verifyCode('email', email, code);
    if (!valid) {
      return reply.status(400).send({ success: false, error: { code: 'INVALID_CODE', message: '验证码错误或已过期' } });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.id !== request.user!.userId) {
      return reply.status(409).send({ success: false, error: { code: 'EMAIL_TAKEN', message: '该邮箱已被使用' } });
    }
    await prisma.user.update({ where: { id: request.user!.userId }, data: { email } });
    return { success: true, message: '邮箱绑定成功' };
  });

  // 绑定/换绑手机
  app.put('/api/v1/user/bind-phone', { preHandler: [jwtAuth] }, async (request, reply) => {
    const parsed = bindPhoneSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || "参数错误" } });
    }
    const { phone, code } = parsed.data;
    // 校验验证码
    const valid = await verifyCode('phone', phone, code);
    if (!valid) {
      return reply.status(400).send({ success: false, error: { code: 'INVALID_CODE', message: '验证码错误或已过期' } });
    }
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing && existing.id !== request.user!.userId) {
      return reply.status(409).send({ success: false, error: { code: 'PHONE_TAKEN', message: '该手机号已被使用' } });
    }
    await prisma.user.update({ where: { id: request.user!.userId }, data: { phone } });
    return { success: true, message: '手机号绑定成功' };
  });

  // 注销账户
  app.delete('/api/v1/user/account', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { code, password } = request.body as { code?: string; password?: string };
    if (!password) {
      return reply.status(400).send({ success: false, error: { code: 'MISSING_PASSWORD', message: '请输入密码以确认注销' } });
    }
    // 验证密码
    const user = await prisma.user.findUnique({ where: { id: request.user!.userId } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.status(400).send({ success: false, error: { code: 'WRONG_PASSWORD', message: '密码错误' } });
    }
    // 如果有验证码则校验，否则仅密码验证也可
    if (code) {
      const target = user.email || user.phone || '';
      const type = user.email ? 'email' : 'phone';
      const valid = await verifyCode(type, target, code);
      if (!valid) {
        return reply.status(400).send({ success: false, error: { code: 'INVALID_CODE', message: '验证码错误或已过期' } });
      }
    }
    await prisma.user.delete({ where: { id: request.user!.userId } });
    return { success: true, message: '账户已注销' };
  });
}
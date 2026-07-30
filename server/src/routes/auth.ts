import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { getRedis } from '../config/redis';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { registerSchema, loginSchema, sendCodeSchema } from '../utils/validators';
import { jwtAuth } from '../middleware/auth';
import { decryptApiKey } from '../utils/apiKey';

// 验证码有效期 5 分钟
const CODE_TTL = 5 * 60;

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 验证码存储：优先用 Redis，不给用 Map
async function saveCode(type: string, target: string, code: string): Promise<void> {
  const key = `verify:${type}:${target}`;
  try {
    const redis = getRedis();
    if (redis) {
      await redis.set(key, code, 'EX', CODE_TTL);
      return;
    }
  } catch {}
  // Redis 不可用时存内存（服务重启会丢失，仅开发环境适用）
  if (!globalThis.__codeStore) globalThis.__codeStore = new Map();
  globalThis.__codeStore.set(key, { code, expires: Date.now() + CODE_TTL * 1000 });
}

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

export default async function authRoutes(app: FastifyInstance) {
  // 发送验证码
  app.post('/api/v1/auth/send-code', async (request, reply) => {
    const parsed = sendCodeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || '参数错误' } });
    }
    const { type, target } = parsed.data;

    // 限流：同一 target 60秒内只能发一次
    const rateLimitKey = `ratelimit:sendcode:${type}:${target}`;
    try {
      const redis = getRedis();
      if (redis) {
        const limited = await redis.get(rateLimitKey);
        if (limited) {
          return reply.status(429).send({ success: false, error: { code: 'RATE_LIMITED', message: '发送太频繁，请60秒后再试' } });
        }
        await redis.set(rateLimitKey, '1', 'EX', 60);
      }
    } catch {}

    const code = generateCode();
    await saveCode(type, target, code);

    // 开发环境打印验证码（生产环境通过短信/邮件发送）
    if (process.env.NODE_ENV === 'development') {
      app.log.info(`[验证码] ${type}:${target} → ${code}`);
    }
    return { success: true, message: '验证码已发送' };
  });

  // 用户注册
  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || '参数错误' } });
    }
    const { username, password, turnstileToken } = parsed.data;

    // 验证 Turnstile（防机器人）
    const turnstileSetting = await prisma.systemSetting.findUnique({ where: { key: 'turnstile_secret_key' } });
    if (turnstileSetting?.value && turnstileToken) {
      const secretKey = decryptApiKey(turnstileSetting.value);
      const form = new URLSearchParams();
      form.set('secret', secretKey);
      form.set('response', turnstileToken);
      try {
        const verifyResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', body: form,
        });
        const verifyData = await verifyResp.json() as any;
        if (!verifyData.success) {
          return reply.status(400).send({ success: false, error: { code: 'TURNSTILE_FAILED', message: '人机验证失败，请重试' } });
        }
      } catch {
        // 网络错误时放行（避免验证服务不可用导致注册瘫痪）
        app.log.warn('Turnstile 验证服务不可达，跳过验证');
      }
    }
    // 检查注册开关
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'registration_enabled' } });
    if (setting?.value === 'false') {
      return reply.status(403).send({ success: false, error: { code: 'REGISTRATION_DISABLED', message: '当前未开放注册' } });
    }
    // 检查用户名是否已存在
    const existing = await prisma.user.findFirst({ where: { username } });
    if (existing) {
      return reply.status(409).send({ success: false, error: { code: 'USER_EXISTS', message: '用户名已存在' } });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { username, passwordHash },
    });

    const payload = { userId: user.id, role: user.role, username: user.username };
    return {
      success: true,
      data: {
        userId: user.id,
        username: user.username,
        accessToken: generateAccessToken(payload),
        refreshToken: generateRefreshToken(payload),
        expiresIn: 3600,
      },
    };
  });

  // 用户登录（带失败限流）
  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error?.issues?.[0]?.message || '参数错误' } });
    }
    const { account, password } = parsed.data;

    // 登录失败限流：每 IP+账号 5次/5分钟
    const ip = request.ip;
    const rateKey = `login:fail:${ip}:${account}`;
    try {
      const redis = getRedis();
      if (redis) {
        const fails = await redis.get(rateKey);
        if (fails && parseInt(fails) >= 5) {
          const ttl = await redis.ttl(rateKey);
          return reply.status(429).send({
            success: false,
            error: { code: 'LOGIN_LOCKED', message: `登录尝试次数过多，请${ttl > 0 ? ttl : 300}秒后再试` },
          });
        }
        await redis.incr(rateKey);
        await redis.expire(rateKey, 300); // 5分钟窗口
      }
    } catch {}

    const user = await prisma.user.findFirst({ where: { OR: [{ email: account }, { phone: account }, { username: account }] } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.status(401).send({ success: false, error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误' } });
    }
    if (!user.isActive) {
      return reply.status(403).send({ success: false, error: { code: 'ACCOUNT_DISABLED', message: '账号已被禁用' } });
    }
    // 登录成功，清除失败计数
    try { const redis = getRedis(); if (redis) await redis.del(rateKey); } catch {}

    const payload = { userId: user.id, role: user.role, username: user.username };
    return {
      success: true,
      data: {
        userId: user.id,
        username: user.username,
        role: user.role,
        accessToken: generateAccessToken(payload),
        refreshToken: generateRefreshToken(payload),
        expiresIn: 3600,
      },
    };
  });

  // 刷新 Token
  app.post('/api/v1/auth/refresh-token', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string };
    if (!refreshToken) {
      return reply.status(400).send({ success: false, error: { code: 'MISSING_TOKEN', message: '缺少 refreshToken' } });
    }
    try {
      const payload = verifyRefreshToken(refreshToken);
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user || !user.isActive) {
        return reply.status(401).send({ success: false, error: { code: 'INVALID_TOKEN', message: 'Token无效' } });
      }
      const newPayload = { userId: user.id, role: user.role, username: user.username };
      return {
        success: true,
        data: {
          accessToken: generateAccessToken(newPayload),
          refreshToken: generateRefreshToken(newPayload),
          expiresIn: 3600,
        },
      };
    } catch {
      return reply.status(401).send({ success: false, error: { code: 'TOKEN_EXPIRED', message: 'RefreshToken已过期' } });
    }
  });

  // 获取当前用户信息
  app.get('/api/v1/auth/me', { preHandler: [jwtAuth] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { id: true, username: true, email: true, phone: true, role: true, avatarUrl: true, createdAt: true },
    });
    if (!user) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '用户不存在' } });
    return { success: true, data: user };
  });
}
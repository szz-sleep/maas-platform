import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import { sha256 } from '../utils/apiKey';
import prisma from '../config/database';

// 扩展 Fastify 请求类型
declare module 'fastify' {
  interface FastifyRequest {
    user?: TokenPayload;
    apiKeyId?: number;
    apiKeyUserId?: number;
  }
}

// JWT 鉴权中间件（用户登录态）
export async function jwtAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  }

  try {
    const token = authHeader.substring(7);
    const payload = verifyAccessToken(token);
    request.user = payload;
  } catch (err) {
    return reply.status(401).send({ success: false, error: { code: 'TOKEN_EXPIRED', message: 'Token已过期，请重新登录' } });
  }
}

// API Key 鉴权中间件（模型调用）
export async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ success: false, error: { code: 'INVALID_API_KEY', message: 'API Key 无效或缺失' } });
  }

  const keyValue = authHeader.substring(7);
  // 用 hash 查询替代全量解密遍历，O(1) 查询
  const keyHash = sha256(keyValue);

  const key = await prisma.apiKey.findFirst({
    where: { keyHash, status: 'active' },
    select: { id: true, userId: true, quotaTotal: true, quotaUsed: true },
  });

  if (!key) {
    return reply.status(401).send({ success: false, error: { code: 'INVALID_API_KEY', message: 'API Key 无效或已过期' } });
  }

  // 检查配额
  if (Number(key.quotaUsed) >= Number(key.quotaTotal)) {
    return reply.status(403).send({ success: false, error: { code: 'QUOTA_EXHAUSTED', message: '算力额度已用完，请联系管理员充值' } });
  }

  request.apiKeyId = key.id;
  request.apiKeyUserId = key.userId;
}

// 管理员权限中间件
export async function adminAuth(request: FastifyRequest, reply: FastifyReply) {
  await jwtAuth(request, reply);
  // jwtAuth 可能已经发送了 reply（如 token 过期），需要检查
  if (reply.sent) return;
  if (!request.user || request.user.role !== 'admin') {
    return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: '仅管理员可操作' } });
  }
}
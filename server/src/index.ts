import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config, validateConfig } from './config';
import { connectRedis } from './config/redis';
import { startModelSyncCron } from './services/model-sync-cron';
import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import keyRoutes from './routes/key';
import modelRoutes from './routes/model';
import generateRoutes from './routes/generate';
import adminRoutes from './routes/admin';
import settingsRoutes from './routes/settings';
import understandRoutes from './routes/understand';
import fileRoutes from './routes/files';
import openaiCompatRoutes from './routes/openai-compat';
import assetRoutes from './routes/assets';

async function main() {
  // 启动前校验密钥配置
  validateConfig();

  const app = Fastify({ logger: config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : true });

  // 注册插件
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] });
  await app.register(multipart, {
    limits: { fileSize: 512 * 1024 * 1024 }, // 512MB
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'MaaS Platform API', version: '1.0.0', description: 'MaaS 模型服务平台 API 文档' },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/documentation' });
  
  // 限流配置（Redis 后端，生产级）
  // 分层策略：
  //   - 认证接口：10次/分钟（防暴力破解）
  //   - 模型调用接口：按用户配额 + 全局限流
  //   - 管理后台：100次/分钟
  try {
    const { getRedis } = await import('./config/redis');
    const redisClient = getRedis();

    const rateLimit = await import('@fastify/rate-limit');
    // 全局默认限流（宽松）
    await app.register(rateLimit.default, {
      max: 300,
      timeWindow: '1 minute',
      redis: redisClient,
      keyGenerator: (req) => {
        // 用 IP + User ID 组合作为 key
        const userId = (req as any).user?.userId || 'anon';
        return `${req.ip}:${userId}`;
      },
    });

    // 认证接口限流（严格）— 通过路由级覆盖
    // 在 auth.ts 中单独配置
  } catch (err) {
    console.warn('⚠️  全局限流插件配置失败（后台继续运行）:', err);
    // 降级：使用内存限流
    try {
      const rateLimit = await import('@fastify/rate-limit');
      await app.register(rateLimit.default, {
        max: 300,
        timeWindow: '1 minute',
      });
    } catch {
      console.warn('⚠️  限流功能不可用');
    }
  }

  // 注册路由
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(keyRoutes);
  await app.register(modelRoutes);
  await app.register(generateRoutes);
  await app.register(adminRoutes);
  await app.register(settingsRoutes);
  await app.register(understandRoutes);
  await app.register(fileRoutes);
  await app.register(openaiCompatRoutes);
  await app.register(assetRoutes);

  // 启动自部署模型同步（扫描 Ollama 等本地后端）
  try {
    startModelSyncCron(60000, ['http://localhost:11434']);
    console.log('🔄 模型同步定时任务已启动');
  } catch (err) {
    console.warn('⚠️  模型同步启动失败（后台继续运行）:', err);
  }

  // 健康检查
  app.get('/api/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // 连接 Redis
  await connectRedis();

  // 启动服务
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`\n🚀 MaaS 服务已启动: http://localhost:${config.port}`);
    console.log(`📚 API 文档: http://localhost:${config.port}/documentation`);
    console.log(`🏥 健康检查: http://localhost:${config.port}/api/health\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
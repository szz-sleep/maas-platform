import { FastifyInstance } from 'fastify';
import prisma from '../config/database';

export default async function modelRoutes(app: FastifyInstance) {
  // 获取模型列表（公开）
  app.get('/api/v1/models', async (request, reply) => {
    const models = await prisma.model.findMany({
      select: {
        id: true, name: true, displayName: true, description: true,
        usageHint: true, modelType: true, status: true, isHot: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return { success: true, data: models };
  });

  // 获取模型详情
  app.get('/api/v1/models/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const model = await prisma.model.findUnique({ where: { name } });
    if (!model) return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '模型不存在' } });
    return { success: true, data: model };
  });

  // 模型注册接口（供外部模型管理服务调用，如 Ollama/vLLM 检测脚本）
  // POST /api/v1/models/register — 批量注册/更新模型状态
  // Body: { models: [{ name, displayName, source, modelType, status, ... }] }
  app.post('/api/v1/models/register', async (request, reply) => {
    const { apiKey, models } = request.body as { apiKey?: string; models: any[] };
    // 简单的内部 API Key 验证（不是用户 Key）
    if (!apiKey || apiKey !== (process.env.MODEL_REGISTER_KEY || 'maas-internal-register-key')) {
      return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '内部 API Key 无效' } });
    }
    if (!Array.isArray(models) || models.length === 0) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: 'models 数组不能为空' } });
    }

    const results = { created: 0, updated: 0, offline: 0 };
    for (const m of models) {
      if (!m.name) continue;
      await prisma.model.upsert({
        where: { name: m.name },
        update: {
          displayName: m.displayName || m.name,
          source: m.source || 'local',
          modelType: m.modelType || 'chat',
          status: m.status || 'online',
          description: m.description || null,
          volcanoModelId: m.volcanoModelId || null,
          unitCost: m.unitCost || 0.01,
          config: m.config || {},
          loadTime: m.status === 'online' ? new Date() : undefined,
        },
        create: {
          name: m.name,
          displayName: m.displayName || m.name,
          source: m.source || 'local',
          modelType: m.modelType || 'chat',
          status: m.status || 'online',
          description: m.description || null,
          volcanoModelId: m.volcanoModelId || null,
          unitCost: m.unitCost || 0.01,
          config: m.config || {},
        },
      });
      if (m.status === 'offline') results.offline++;
    }

    return { success: true, data: results, message: `已同步 ${models.length} 个模型` };
  });
}
/**
 * 模型同步服务 — 自动检测自部署模型并注册到平台
 *
 * 支持的后端：
 *   - Ollama（本地/远程）→ 通过 /api/tags 检测
 *   - vLLM（远程）→ 通过 /v1/models 检测（OpenAI 兼容）
 *   - OpenAI 兼容端点 → 通用检测
 *
 * 运行方式：
 *   1. 启动时同步一次
 *   2. 定时任务（server/src/services/model-sync-cron.ts）
 *   3. 手动触发（通过管理后台 API）
 *
 * 已注册模型的管理：
 *   - 如果 Ollama 中不再存在某个已注册模型 → 标记为 offline
 *   - 之前标记 offline 的模型重新出现 → 自动恢复 online
 *   - 未变更的模型保持不变
 */

import prisma from '../config/database';

interface DetectedModel {
  name: string;
  displayName: string;
  modelType: string;
  source: string;
  parameterSize?: string;
  quantizationLevel?: string;
  capabilities?: string[];
  endpoint: string; // base URL of the model server
}

/**
 * 从 Ollama 检测已加载模型
 */
async function detectOllamaModels(endpoint: string = 'http://localhost:11434'): Promise<DetectedModel[]> {
  try {
    const resp = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.warn(`[model-sync] Ollama ${endpoint} 返回 ${resp.status}`);
      return [];
    }
    const data = await resp.json() as any;
    const models: DetectedModel[] = [];

    for (const m of data.models || []) {
      const caps = m.capabilities || [];
      // 根据能力推断类型：有 completion=chat，有 embedding=embedding
      const modelType = caps.includes('embedding') ? 'embedding' : 'chat';

      models.push({
        name: `ollama/${m.name}`,
        displayName: `${m.name} (Ollama)`,
        modelType,
        source: 'local',
        parameterSize: m.details?.parameter_size,
        quantizationLevel: m.details?.quantization_level,
        capabilities: caps,
        endpoint,
      });
    }
    return models;
  } catch (err) {
    console.warn(`[model-sync] 检测 Ollama 失败 (${endpoint}): ${(err as Error).message}`);
    return [];
  }
}

/**
 * 从 vLLM / OpenAI 兼容端点检测模型
 */
async function detectOpenAICompatibleModels(
  endpoint: string = 'http://localhost:8000',
  label: string = 'vLLM'
): Promise<DetectedModel[]> {
  try {
    const resp = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.warn(`[model-sync] ${label} ${endpoint} 返回 ${resp.status}`);
      return [];
    }
    const data = await resp.json() as any;
    const models: DetectedModel[] = [];

    for (const m of data.data || []) {
      // vLLM 模型 ID 格式如 "meta-llama/Llama-3-8B-Instruct"
      const rawName = m.id || m.name;
      if (!rawName) continue;

      models.push({
        name: `${label.toLowerCase()}/${rawName}`,
        displayName: `${rawName} (${label})`,
        modelType: 'chat',
        source: 'local',
        capabilities: m.capabilities || [],
        endpoint,
      });
    }
    return models;
  } catch (err) {
    console.warn(`[model-sync] 检测 ${label} 失败 (${endpoint}): ${(err as Error).message}`);
    return [];
  }
}

/**
 * 主同步函数：扫描所有后端，合并结果，更新数据库
 */
export async function syncModels(options?: {
  ollamaEndpoints?: string[];
  vllmEndpoints?: { endpoint: string; label: string }[];
  dryRun?: boolean;
}): Promise<{ detected: number; registered: number; updated: number; offlined: number }> {
  const ollamaEndpoints = options?.ollamaEndpoints || ['http://localhost:11434'];
  const vllmEndpoints = options?.vllmEndpoints || [];

  // 1. 并行扫描所有后端
  const ollamaResults = await Promise.all(ollamaEndpoints.map(detectOllamaModels));
  const vllmResults = await Promise.all(
    vllmEndpoints.map(({ endpoint, label }) => detectOpenAICompatibleModels(endpoint, label))
  );

  const allDetected = [...ollamaResults.flat(), ...vllmResults.flat()];
  const detectedNames = new Set(allDetected.map(m => m.name));

  if (options?.dryRun) {
    console.log(`[model-sync] 干运行：检测到 ${allDetected.length} 个模型`);
    for (const m of allDetected) {
      console.log(`  ${m.name} (${m.modelType})`);
    }
    return { detected: allDetected.length, registered: 0, updated: 0, offlined: 0 };
  }

  let registered = 0;
  let updated = 0;

  // 2. 将检测到的模型注册/更新到数据库
  for (const m of allDetected) {
    const existing = await prisma.model.findUnique({ where: { name: m.name } });
    if (existing) {
      // 更新：恢复 online 状态（如果之前离线了）、更新配置
      if (existing.status === 'offline') {
        await prisma.model.update({
          where: { name: m.name },
          data: {
            status: 'online',
            displayName: m.displayName,
            modelType: m.modelType,
            config: {
              endpoint: m.endpoint,
              parameterSize: m.parameterSize,
              quantizationLevel: m.quantizationLevel,
              capabilities: m.capabilities,
            },
            loadTime: new Date(),
          },
        });
        updated++;
      } else {
        await prisma.model.update({
          where: { name: m.name },
          data: {
            displayName: m.displayName,
            modelType: m.modelType,
            config: {
              endpoint: m.endpoint,
              parameterSize: m.parameterSize,
              quantizationLevel: m.quantizationLevel,
              capabilities: m.capabilities,
            },
          },
        });
        updated++;
      }
    } else {
      // 新模型：注册
      await prisma.model.create({
        data: {
          name: m.name,
          displayName: m.displayName,
          description: `${m.parameterSize || ''} 自部署模型`.trim(),
          source: 'local',
          modelType: m.modelType,
          status: 'online',
          unitCost: m.modelType === 'embedding' ? 0.001 : 0.01,
          config: {
            endpoint: m.endpoint,
            parameterSize: m.parameterSize,
            quantizationLevel: m.quantizationLevel,
            capabilities: m.capabilities,
          },
          loadTime: new Date(),
        },
      });
      registered++;
    }
  }

  // 3. 将不再存在的本地模型标记为 offline
  const allLocalModels = await prisma.model.findMany({
    where: { source: 'local' },
  });
  let offlined = 0;
  for (const model of allLocalModels) {
    if (!detectedNames.has(model.name) && model.status === 'online') {
      await prisma.model.update({
        where: { name: model.name },
        data: { status: 'offline' },
      });
      offlined++;
    }
  }

  console.log(
    `[model-sync] 同步完成: 检测 ${allDetected.length}, 注册 ${registered}, 更新 ${updated}, 下线 ${offlined}`
  );

  return { detected: allDetected.length, registered, updated, offlined };
}

/**
 * 模型同步服务 — 自动检测自部署模型和火山引擎模型并注册到平台
 *
 * 火山引擎价格映射 — 对齐火山方舟官方定价
 * - token 计费：元/百万tokens（input/output）
 * - 按秒计费：元/秒（视频类）
 * - 按次计费：元/次（图片/3D 类）
 */
const VOLCANO_PRICES: Record<string, { inp?: number; out?: number; perSec?: number; perCall?: number }> = {
  // === 豆包 LLM 系列（元/百万tokens） — 按系列前缀匹配 ===
  'doubao-lite-4k': { inp: 0.15, out: 0.30 },
  'doubao-lite-32k': { inp: 0.30, out: 0.80 },
  'doubao-lite-128k': { inp: 0.30, out: 0.80 },
  'doubao-lite-256k': { inp: 0.30, out: 0.80 },
  'doubao-pro-4k': { inp: 0.80, out: 2.00 },
  'doubao-pro-32k': { inp: 0.80, out: 2.00 },
  'doubao-pro-128k': { inp: 1.50, out: 6.00 },
  'doubao-pro-256k': { inp: 1.50, out: 6.00 },
  'doubao-vision-pro-32k': { inp: 3.00, out: 9.00 },
  'doubao-pro-1.5-32k': { inp: 5.00, out: 20.00 },
  // DeepSeek 系列
  'deepseek-r1': { inp: 4.00, out: 16.00 },
  'deepseek-v3': { inp: 2.00, out: 8.00 },
  // === 视频生成 Seedance（元/秒） — 按系列前缀匹配 ===
  'doubao-seedance-2-0-pro': { perSec: 0.6 },
  'doubao-seedance-2-0-fast': { perSec: 0.4 },
  'doubao-seedance-2-0-mini': { perSec: 0.1 },
  'doubao-seedance-2-5': { perSec: 0.6 },
  'doubao-seedance-1-5-pro': { perSec: 0.6 },
  'doubao-seedance-1-0-pro': { perSec: 0.6 },
  'doubao-seedance-1-0-lite': { perSec: 0.3 },
  // === 图片生成 Seedream（元/张） — 按系列前缀匹配 ===
  'doubao-seedream-5-0': { perCall: 0.05 },
  'doubao-seedream-5-5': { perCall: 0.05 },
  'doubao-seedream-4-5': { perCall: 0.04 },
  'doubao-seedream-4-0': { perCall: 0.04 },
  'doubao-seedream-3-0': { perCall: 0.04 },
  // === 嵌入模型（元/百万tokens） — 按系列前缀匹配 ===
  'doubao-embedding-text': { inp: 0.20, out: 0 },
  'doubao-embedding-large-text': { inp: 0.20, out: 0 },
  'doubao-embedding-vision': { inp: 0.50, out: 0 },
  // === 3D 模型（元/次） — 按系列前缀匹配 ===
  'doubao-seed3d-2-0': { perCall: 0.20 },
  'doubao-seed3d-1-0': { perCall: 0.20 },
};

/** 根据火山模型 ID 和类型获取默认价格 */
function resolvePrice(volcanoModelId: string, modelType: string): {
  unitCost: number;
  per1mInputTokens?: number;
  per1mOutputTokens?: number;
  unitCostPerSecond?: number;
} {
  // 1. 精确匹配
  const known = VOLCANO_PRICES[volcanoModelId];
  if (known) {
    if (known.inp !== undefined || known.out !== undefined) {
      return { unitCost: 0.01, per1mInputTokens: known.inp ?? 0, per1mOutputTokens: known.out ?? 0 };
    }
    if (known.perSec !== undefined) {
      return { unitCost: known.perSec, unitCostPerSecond: known.perSec };
    }
    if (known.perCall !== undefined) {
      return { unitCost: known.perCall };
    }
  }
  // 2. 前缀匹配（覆盖同一模型的不同版本）
  for (const [key, price] of Object.entries(VOLCANO_PRICES)) {
    const prefix = key.replace(/-\d{6,}$/, ''); // 去掉末尾日期版本号
    if (volcanoModelId.startsWith(prefix)) {
      if (price.inp !== undefined || price.out !== undefined) {
        return { unitCost: 0.01, per1mInputTokens: price.inp ?? 0, per1mOutputTokens: price.out ?? 0 };
      }
      if (price.perSec !== undefined) {
        return { unitCost: price.perSec, unitCostPerSecond: price.perSec };
      }
      if (price.perCall !== undefined) {
        return { unitCost: price.perCall };
      }
    }
  }
  // 3. 按类型给兜底
  const defaults: Record<string, number> = { video: 0.2, image: 0.04, chat: 0.01, embedding: 0.001, audio: 0.05, '3d': 0.2 };
  return { unitCost: defaults[modelType] || 0.1 };
}

/**
 *
 * 支持的后端：
 *   1. LLM 架构：Ollama、vLLM / OpenAI 兼容端点（chat / embedding）
 *   2. Diffusers 架构：Stable Diffusion WebUI / ComfyUI（image）
 *   3. 火山引擎：通过 Ark API /api/v3/models 动态拉取
 *
 * 运行方式：
 *   - 启动时同步一次
 *   - 定时任务（server/src/services/model-sync-cron.ts）
 *   - 管理后台手动触发 API
 *
 * 已注册模型管理：
 *   - 不在检测列表中的 → 删除
 *   - 重新出现的 → 自动恢复 online
 *   - 未变更的 → 保持不变
 */

import prisma from '../config/database';
import { loadApiKey } from './volcano';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

interface DetectedModel {
  name: string;
  displayName: string;
  description: string;
  modelType: string;
  source: string;
  volcanoModelId?: string;
  volcanoEndpoint?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  capabilities?: string[];
  endpoint: string;
  /** 额外的 API 配置（价格、并发限制等） */
  extra?: Record<string, unknown>;
}

// ──────────────────────────────────────────────
// 火山引擎模型检测
// ──────────────────────────────────────────────

/** 火山引擎模型领域 → 平台类型映射 */
const DOMAIN_TO_TYPE: Record<string, string> = {
  VideoGeneration: 'video',
  ImageGeneration: 'image',
  LLM: 'chat',
  VLM: 'chat',
  Embedding: 'embedding',
  Router: 'chat',
  '3DGeneration': '3d',
};

/** 从火山引擎模型 ID → 平台展示名（去掉冗余后缀） */
function volcanoDisplayName(volcanoId: string, rawName: string): string {
  // rawName 通常是简短名，如 "doubao-seedance-2-0"
  return rawName;
}

/** 生成平台唯一模型名（用小写无空格） */
function platformModelName(volcanoId: string): string {
  return volcanoId.toLowerCase();
}

/**
 * 从火山引擎 Ark API 拉取所有可用模型
 */
async function detectVolcanoModels(): Promise<DetectedModel[]> {
  try {
    const apiKey = await loadApiKey();
    if (!apiKey) {
      console.warn('[model-sync] 未配置火山引擎 API Key，跳过火山模型检测');
      return [];
    }

    const resp = await fetch('https://ark.cn-beijing.volces.com/api/v3/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.warn(`[model-sync] 火山 API 返回 ${resp.status}: ${await resp.text().then(t => t.substring(0, 200))}`);
      return [];
    }

    const body = (await resp.json()) as { data?: VolcanoModel[] };
    const rawModels = body.data || [];
    const models: DetectedModel[] = [];

    for (const m of rawModels) {
      // 跳过已下线的模型
      if (m.status && m.status !== 'Shutdown' && m.status !== 'Retiring') continue;

      const modelType = DOMAIN_TO_TYPE[m.domain] || 'chat';
      const volcanoId = m.id;

      // 构建中文友好的描述
      const tasks = m.task_type?.length
        ? m.task_type.map(t => ({ TextToVideo: '文生视频', ImageToVideo: '图生视频', TextToImage: '文生图',
            ImageToImage: '图生图', TextGeneration: '文本生成', VisualQuestionAnswering: '视觉问答',
            SpeechToText: '语音转文字', TextEmbedding: '文本嵌入', ImageEmbedding: '图片嵌入',
            TextToAudioVideo: '文生音视频', ImageToAudioVideo: '图生音视频',
            MultimodalToVideo: '多模态生视频', VideoExtension: '视频扩展', VideoEditing: '视频编辑',
            ImageTo3D: '图生3D',
          }[t] || t)).join('、')
        : `${modelTypeMap(modelType)}`;

      // 构建多媒体能力标签
      const modalities: string[] = [];
      if (m.modalities?.input_modalities?.length) modalities.push(...m.modalities.input_modalities);
      const modalityTags = modalityLabel(modalities);

      models.push({
        name: platformModelName(volcanoId),
        displayName: volcanoDisplayName(volcanoId, m.name),
        description: `${tasks}${modalityTags ? ` · ${modalityTags}` : ''}`,
        modelType,
        source: 'volcano',
        volcanoModelId: volcanoId,
        volcanoEndpoint: `https://ark.cn-beijing.volces.com/api/v3`,
        capabilities: m.task_type,
        endpoint: '',
        extra: {
          volcanoName: m.name,
          version: m.version,
          domain: m.domain,
          status: m.status,
          tokenLimits: m.token_limits,
        },
      });
    }

    return models;
  } catch (err) {
    console.warn(`[model-sync] 检测火山模型失败: ${(err as Error).message}`);
    return [];
  }
}

function modelTypeMap(t: string): string {
  return { video: '视频生成', image: '图片生成', chat: '对话', embedding: '嵌入', audio: '音频', '3d': '3D生成' }[t] || t;
}

function modalityLabel(modalities: string[]): string {
  const map: Record<string, string> = { text: '文', image: '图', video: '视频', audio: '音频', three_d: '3D' };
  return [...new Set(modalities.map(m => map[m]))].filter(Boolean).join('+');
}

// ──────────────────────────────────────────────
// 自部署模型检测（Ollama / vLLM）
// ──────────────────────────────────────────────

interface DetectedLocalModel {
  name: string;
  displayName: string;
  modelType: string;
  source: string;
  parameterSize?: string;
  quantizationLevel?: string;
  capabilities?: string[];
  endpoint: string;
}

async function detectOllamaModels(endpoint: string = 'http://localhost:11434'): Promise<DetectedLocalModel[]> {
  try {
    const resp = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.warn(`[model-sync] Ollama ${endpoint} 返回 ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as any;
    const models: DetectedLocalModel[] = [];

    for (const m of data.models || []) {
      const caps = m.capabilities || [];
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

async function detectOpenAICompatibleModels(
  endpoint: string = 'http://localhost:8000',
  label: string = 'vLLM'
): Promise<DetectedLocalModel[]> {
  try {
    const resp = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.warn(`[model-sync] ${label} ${endpoint} 返回 ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as any;
    const models: DetectedLocalModel[] = [];

    for (const m of data.data || []) {
      const rawName = m.id || m.name;
      if (!rawName) continue;
      // vLLM 默认都是 chat 类型，后续可通过 vllmModelTypes 覆盖
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

// ──────────────────────────────────────────────
// Diffusers 架构检测（SD WebUI / ComfyUI）
// ──────────────────────────────────────────────

export interface DiffusersEndpoint {
  endpoint: string;
  label: string;       // 显示标签，如 "SD WebUI"、"ComfyUI"
  type: 'sdwebui' | 'comfyui';
}

/**
 * Stable Diffusion WebUI 模型检测
 * SD WebUI 暴露 /sdapi/v1/sd-models 端点
 */
async function detectSDWebUIModels(
  endpoint: string,
  label: string
): Promise<DetectedLocalModel[]> {
  try {
    const resp = await fetch(`${endpoint}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      console.warn(`[model-sync] ${label} ${endpoint} 返回 ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as any[];
    const models: DetectedLocalModel[] = [];

    for (const m of data || []) {
      const modelName = m.model_name || m.title;
      if (!modelName) continue;
      models.push({
        name: `sd/${modelName.replace(/\s+/g, '-').toLowerCase()}`,
        displayName: `${modelName} (${label})`,
        modelType: 'image',
        source: 'local',
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
 * ComfyUI 模型检测
 * ComfyUI 通过 /object_info 获取可用 checkpoint
 * 同时检测 /system_stats 确认服务存活
 */
async function detectComfyUIModels(
  endpoint: string,
  label: string
): Promise<DetectedLocalModel[]> {
  try {
    // ComfyUI 的 /object_info 返回所有节点类型和参数
    // 从中提取 CheckpointLoaderSimple 的 ckpt_name 选项
    const resp = await fetch(`${endpoint}/object_info`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      console.warn(`[model-sync] ${label} ${endpoint} 返回 ${resp.status}`);
      return [];
    }
    const data = (await resp.json()) as any;
    const models: DetectedLocalModel[] = [];

    // 尝试从 CheckpointLoaderSimple 提取模型列表
    const checkpointLoader = data.CheckpointLoaderSimple || data.CheckpointLoader;
    if (checkpointLoader?.input?.required?.ckpt_name?.[0]) {
      const modelList = checkpointLoader.input.required.ckpt_name[0];
      if (Array.isArray(modelList)) {
        for (const name of modelList) {
          if (typeof name === 'string' && !name.endsWith('.safetensors') && !name.endsWith('.ckpt')) {
            // 跳过纯文件名键
          }
          const cleanName = typeof name === 'string' ? name : String(name);
          models.push({
            name: `comfy/${cleanName.replace(/\s+/g, '-').toLowerCase()}`,
            displayName: `${cleanName} (${label})`,
            modelType: 'image',
            source: 'local',
            endpoint,
          });
        }
      }
    }

    // 如果没拿到模型列表，至少注册一个 ComfyUI 端点标记
    if (models.length === 0) {
      models.push({
        name: `comfy/default`,
        displayName: `ComfyUI 默认工作流 (${label})`,
        modelType: 'image',
        source: 'local',
        endpoint,
      });
    }

    return models;
  } catch (err) {
    console.warn(`[model-sync] 检测 ${label} 失败 (${endpoint}): ${(err as Error).message}`);
    return [];
  }
}

// ──────────────────────────────────────────────
// 主同步函数
// ──────────────────────────────────────────────

export async function syncModels(options?: {
  ollamaEndpoints?: string[];
  vllmEndpoints?: { endpoint: string; label: string; modelTypes?: Record<string, string> }[];
  diffusersEndpoints?: DiffusersEndpoint[];
  includeVolcano?: boolean;
  dryRun?: boolean;
}): Promise<{ detected: number; registered: number; updated: number; removed: number }> {
  const ollamaEndpoints = options?.ollamaEndpoints?.length ? options.ollamaEndpoints : [];
  const vllmEndpoints = options?.vllmEndpoints || [];
  const diffusersEndpoints = options?.diffusersEndpoints || [];
  const includeVolcano = options?.includeVolcano !== false; // 默认 true

  // 1. 并行扫描所有后端
  const ollamaResults = await Promise.all(ollamaEndpoints.map(detectOllamaModels));
  const vllmResults = await Promise.all(
    vllmEndpoints.map(({ endpoint, label, modelTypes }) =>
      detectOpenAICompatibleModels(endpoint, label).then(models =>
        // 支持覆盖模型类型（如 deepseek: chat, bge-m3: embedding）
        modelTypes
          ? models.map(m => ({ ...m, modelType: modelTypes[m.name.replace(`${label.toLowerCase()}/`, '')] || m.modelType }))
          : models
      )
    )
  );
  const diffusersResults = await Promise.all(
    diffusersEndpoints.map(({ endpoint, label, type }) =>
      type === 'comfyui' ? detectComfyUIModels(endpoint, label) : detectSDWebUIModels(endpoint, label)
    )
  );
  const volcanoResults = includeVolcano ? await detectVolcanoModels() : [];

  const allDetected: DetectedModel[] = [
    ...ollamaResults.flat().map(m => ({ ...m, description: '', volcanoModelId: undefined, volcanoEndpoint: undefined, extra: undefined })),
    ...vllmResults.flat().map(m => ({ ...m, description: '', volcanoModelId: undefined, volcanoEndpoint: undefined, extra: undefined })),
    ...diffusersResults.flat().map(m => ({ ...m, description: '', volcanoModelId: undefined, volcanoEndpoint: undefined, extra: undefined })),
    ...volcanoResults,
  ];
  const detectedNames = new Set(allDetected.map(m => m.name));

  if (options?.dryRun) {
    console.log(`[model-sync] 干运行：检测到 ${allDetected.length} 个模型`);
    for (const m of allDetected) console.log(`  [${m.source}] ${m.name} (${m.modelType}) — ${m.description}`);
    return { detected: allDetected.length, registered: 0, updated: 0, removed: 0 };
  }

  let registered = 0;
  let updated = 0;

  // 2. 注册/更新检测到的模型
  for (const m of allDetected) {
    const existing = await prisma.model.findUnique({ where: { name: m.name } });

    const baseData = {
      displayName: m.displayName,
      description: m.description,
      modelType: m.modelType,
      source: m.source,
      status: 'online' as const,
      config: m.source === 'local'
        ? { endpoint: m.endpoint, parameterSize: (m as DetectedLocalModel).parameterSize, quantizationLevel: (m as DetectedLocalModel).quantizationLevel, capabilities: m.capabilities }
        : { volcanoModelId: m.volcanoModelId, volcanoEndpoint: m.volcanoEndpoint, capabilities: m.capabilities, ...(m.extra || {}) },
      loadTime: new Date(),
    };

    // 火山模型的价格从映射表取；自部署模型用默认
    const price = m.source === 'volcano' && m.volcanoModelId
      ? resolvePrice(m.volcanoModelId, m.modelType)
      : { unitCost: { video: 0.2, image: 0.04, chat: 0.01, embedding: 0.001, '3d': 0.2 }[m.modelType] || 0.1 };

    if (existing) {
      await prisma.model.update({
        where: { name: m.name },
        data: {
          ...baseData,
          ...price,
        },
      });
      updated++;
    } else {
      await prisma.model.create({
        data: {
          name: m.name,
          ...baseData,
          ...price,
          volcanoModelId: m.volcanoModelId,
          volcanoEndpoint: m.volcanoEndpoint,
        },
      });
      registered++;
    }
  }

  // 3. 删除不在检测列表中的模型
  // 火山模型：没出现在检测列表就删除（火山 API Key 清空后自动消失）
  // 本地模型：仅在本地服务成功连接且返回了模型列表时才删除；连接失败时保留已有记录
  const allTracked = await prisma.model.findMany({
    where: { source: { in: ['local', 'volcano'] } },
  });

  // 判断本地检测是否成功（至少有一条本地模型被检测到，或者没有配置本地端点）
  const hasLocalEndpoints = ollamaEndpoints.length > 0 || vllmEndpoints.length > 0 || diffusersEndpoints.length > 0;
  const localDetected = ollamaResults.flat().length + vllmResults.flat().length + diffusersResults.flat().length;
  const localScanOk = !hasLocalEndpoints || localDetected > 0;

  let removed = 0;
  for (const model of allTracked) {
    if (detectedNames.has(model.name)) continue;

    if (model.source === 'volcano') {
      // 火山模型：直接删除
      await prisma.model.delete({ where: { name: model.name } });
      removed++;
    } else if (model.source === 'local' && localScanOk) {
      // 本地模型：仅当本地服务正常且模型不在列表中时才删除
      await prisma.model.delete({ where: { name: model.name } });
      removed++;
    }
    // 本地服务连接失败时，保留已有的本地模型
  }

  console.log(
    `[model-sync] 同步完成: 检测 ${allDetected.length}, 注册 ${registered}, 更新 ${updated}, 移除 ${removed}`
  );

  return { detected: allDetected.length, registered, updated, removed };
}

// ──────────────────────────────────────────────
// 火山引擎模型 API 返回类型
// ──────────────────────────────────────────────

interface VolcanoModel {
  id: string;
  name: string;
  created: number;
  domain: string;
  object: string;
  status?: string;
  version: string;
  modalities?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  task_type?: string[];
  token_limits?: Record<string, unknown>;
}

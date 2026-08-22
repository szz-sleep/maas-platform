import prisma from '../config/database';

/**
 * 火山模型标准价格种子数据（依据《火山方舟模型价格》文档，均为标准价，不含限时折扣）
 * 价格单位：
 *  - chat token 模式：元/百万 token
 *  - 视频 token 模式：元/百万 token（按分辨率 + 输入含/不含视频档位）
 *  - 图片：元/张
 * 可被管理端在「价格管理」页覆盖。
 */

// 大语言模型（按 token，元/百万 token）— 取常规在线推理【标准价】，简化用最常见档位
const CHAT_PRICES = [
  { modelKey: 'deepseek-v4-flash正式版', displayName: 'DeepSeek V4 Flash 正式版', input: 3.0, output: 9.0, cache: 0.1 },
  { modelKey: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', input: 1.0, output: 2.0, cache: 0.2 },
  { modelKey: 'deepseek-v4-pro正式版', displayName: 'DeepSeek V4 Pro 正式版', input: 9.0, output: 27.0, cache: 0.3 },
  { modelKey: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', input: 12.0, output: 24.0, cache: 1.0 },
  { modelKey: 'doubao-seed-2.0-pro', displayName: '豆包 Seed 2.0 Pro', input: 3.2, output: 16.0, cache: 0.64 },
  { modelKey: 'doubao-seed-2.0-lite', displayName: '豆包 Seed 2.0 Lite', input: 0.6, output: 3.6, cache: 0.12 },
  { modelKey: 'doubao-seed-2.0-mini', displayName: '豆包 Seed 2.0 Mini', input: 0.2, output: 2.0, cache: 0.04 },
  { modelKey: 'doubao-seed-2.1-pro', displayName: '豆包 Seed 2.1 Pro', input: 6.0, output: 30.0, cache: 1.2 },
  { modelKey: 'doubao-seed-2.1-turbo', displayName: '豆包 Seed 2.1 Turbo', input: 6.0, output: 30.0, cache: 1.2 },
  { modelKey: 'doubao-seed-2.0-code', displayName: '豆包 Seed 2.0 Code', input: 3.2, output: 16.0, cache: 0.64 },
  { modelKey: 'doubao-seed-1.8', displayName: '豆包 Seed 1.8', input: 0.8, output: 2.0, cache: 0.16 },
  { modelKey: 'doubao-seed-1.6', displayName: '豆包 Seed 1.6', input: 0.8, output: 2.0, cache: 0.16 },
  { modelKey: 'doubao-seed-1.6-lite', displayName: '豆包 Seed 1.6 Lite', input: 0.3, output: 0.6, cache: 0.06 },
  { modelKey: 'doubao-seed-1.6-flash', displayName: '豆包 Seed 1.6 Flash', input: 0.15, output: 1.5, cache: 0.03 },
  { modelKey: 'doubao-seed-1.6-vision', displayName: '豆包 Seed 1.6 Vision', input: 0.8, output: 8.0, cache: 0.16 },
  { modelKey: 'doubao-seed-character', displayName: '豆包 Seed Character', input: 0.8, output: 2.0, cache: 0.16 },
  { modelKey: 'doubao-seed-code', displayName: '豆包 Seed Code', input: 1.2, output: 8.0, cache: 0.24 },
  { modelKey: 'doubao-seed-translation', displayName: '豆包 Seed 翻译', input: 1.2, output: 3.6, cache: 0 },
  // 第三方托管模型兜底价（qwen/kimi/mistral/wan 等，文档无官方价；管理端可改）
  { modelKey: 'thirdparty-default', displayName: '第三方模型默认价', input: 4.0, output: 16.0, cache: 0.8 },
  { modelKey: 'glm-5.2', displayName: '智谱 GLM 5.2', input: 8.0, output: 28.0, cache: 2.0 },
  { modelKey: 'glm-4.7', displayName: '智谱 GLM 4.7', input: 2.0, output: 8.0, cache: 0.4 },
  { modelKey: 'doubao-1.5-pro-32k', displayName: '豆包 1.5 Pro 32K', input: 0.8, output: 2.0, cache: 0.16 },
  { modelKey: 'doubao-1.5-lite-32k', displayName: '豆包 1.5 Lite 32K', input: 0.3, output: 0.6, cache: 0.06 },
  { modelKey: 'doubao-pro-32k', displayName: '豆包 Pro 32K', input: 0.8, output: 2.0, cache: 0.16 },
];

// 视频生成模型 doubao-seedance-2.0（按 token，元/百万 token，标准价）
const SEEDANCE_2_0_PRICES = [
  { resolution: '480p', noVideo: 46.0, withVideo: 28.0 },
  { resolution: '720p', noVideo: 46.0, withVideo: 28.0 },
  { resolution: '1080p', noVideo: 51.0, withVideo: 31.0 },
  { resolution: '4k', noVideo: 26.0, withVideo: 16.0 },
];

// seedance-2.0-fast（标准价，原价；仅 480p/720p）
const SEEDANCE_2_0_FAST_PRICES = [
  { resolution: '480p', noVideo: 37.0, withVideo: 22.0 },
  { resolution: '720p', noVideo: 37.0, withVideo: 22.0 },
];

// seedance-2.0-mini（标准价，原价；仅 480p/720p）
const SEEDANCE_2_0_MINI_PRICES = [
  { resolution: '480p', noVideo: 23.0, withVideo: 14.0 },
  { resolution: '720p', noVideo: 23.0, withVideo: 14.0 },
];

// seedance-2.5（标准价，原价）
const SEEDANCE_2_5_PRICES = [
  { resolution: '480p', noVideo: 70.0, withVideo: 42.0 },
  { resolution: '720p', noVideo: 70.0, withVideo: 42.0 },
  { resolution: '1080p', noVideo: 77.0, withVideo: 77.0 },
];

const VIDEO_PRICES = [
  ...seed(SEEDANCE_2_0_PRICES, 'doubao-seedance-2.0', '豆包 Seedance 2.0'),
  ...seed(SEEDANCE_2_0_FAST_PRICES, 'doubao-seedance-2.0-fast', '豆包 Seedance 2.0 Fast'),
  ...seed(SEEDANCE_2_0_MINI_PRICES, 'doubao-seedance-2.0-mini', '豆包 Seedance 2.0 Mini'),
  ...seed(SEEDANCE_2_5_PRICES, 'doubao-seedance-2.5', '豆包 Seedance 2.5'),
];

function seed(rows: { resolution: string; noVideo: number; withVideo: number }[], base: string, label: string) {
  return rows.map(p => ({
    modelKey: `${base}-${p.resolution}`,
    displayName: `${label} (${p.resolution})`,
    input: null, output: null, cache: null,
    resolution: p.resolution, noVideo: p.noVideo, withVideo: p.withVideo,
    perSecond: null, perImage: null, perImageHigh: null,
  }));
}

// 图片生成模型（元/张，标准价）
const IMAGE_PRICES = [
  { modelKey: 'doubao-seedream-5-0-pro', displayName: '豆包 Seedream 5.0 Pro', perImage: 0.30, perImageHigh: 0.60 },
  { modelKey: 'doubao-seedream-5-0-lite', displayName: '豆包 Seedream 5.0 Lite', perImage: 0.22, perImageHigh: 0.22 },
  { modelKey: 'doubao-seedream-4-5', displayName: '豆包 Seedream 4.5', perImage: 0.25, perImageHigh: 0.25 },
  { modelKey: 'doubao-seedream-4-0', displayName: '豆包 Seedream 4.0', perImage: 0.20, perImageHigh: 0.20 },
];

// 本地模型参考价（基于火山对应模型标准价）
const LOCAL_PRICES = [
  // 本地视频：参考 doubao-seedance-2.0 720p（token单价 不含46 / 含28）
  ...SEEDANCE_2_0_PRICES.filter(p => p.resolution === '720p').map(p => ({
    modelKey: 'local-video-720p', displayName: '本地视频（参考 Seedance 2.0 720p）',
    input: null, output: null, cache: null,
    resolution: '720p', noVideo: p.noVideo, withVideo: p.withVideo,
    perSecond: null, perImage: null, perImageHigh: null, refModel: 'doubao-seedance-2.0', source: 'local',
  })),
  // 本地 chat（DeepSeek）：参考 deepseek-v4-flash 正式版
  { modelKey: 'local-deepseek', displayName: '本地 DeepSeek（参考 V4 Flash 正式版）', input: 3.0, output: 9.0, cache: 0.1, refModel: 'deepseek-v4-flash正式版', source: 'local' },
];

/**
 * 初始化/重建价格表（幂等：已存在的 modelKey 不覆盖，缺的补上）
 * @param force - 为 true 时覆盖全部（含已存在的）
 */
export async function seedModelPrices(force = false): Promise<number> {
  let count = 0;

  async function upsert(row: Record<string, any>) {
    const data: any = {
      displayName: row.displayName || null,
      modelType: row.modelType || inferType(row),
      source: row.source || 'volcano',
      priceMode: inferMode(row),
      inputPrice: row.input ?? null,
      outputPrice: row.output ?? null,
      cacheHitPrice: row.cache ?? null,
      resolution: row.resolution || null,
      inputNoVideo: row.noVideo ?? null,
      inputWithVideo: row.withVideo ?? null,
      perSecond: row.perSecond ?? null,
      perImage: row.perImage ?? null,
      perImageHigh: row.perImageHigh ?? null,
      refModel: row.refModel || null,
      remark: row.remark || null,
    };
    const existing = await prisma.modelPrice.findUnique({ where: { modelKey: row.modelKey } });
    if (existing && !force) return; // 已有且非强制：保留管理员自定义
    await prisma.modelPrice.upsert({
      where: { modelKey: row.modelKey },
      update: data,
      create: { modelKey: row.modelKey, ...data },
    });
    count++;
  }

  for (const c of CHAT_PRICES) {
    await upsert({ ...c, modelType: 'chat', priceMode: 'token' });
  }
  for (const v of VIDEO_PRICES) {
    await upsert({ ...v, modelType: 'video', priceMode: 'token' });
  }
  for (const im of IMAGE_PRICES) {
    await upsert({ ...im, modelType: 'image', priceMode: 'per_image' });
  }
  for (const l of LOCAL_PRICES) {
    await upsert({ ...l });
  }

  return count;
}

function inferMode(row: Record<string, any>): string {
  if (row.priceMode) return row.priceMode;
  if (row.perImage != null || row.modelType === 'image') return 'per_image';
  if (row.perSecond != null) return 'per_second';
  return 'token';
}

function inferType(row: Record<string, any>): string {
  if (row.modelType) return row.modelType;
  if (row.perImage != null) return 'image';
  if (row.resolution || row.noVideo != null) return 'video';
  return 'chat';
}

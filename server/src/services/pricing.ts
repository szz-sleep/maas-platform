import prisma from '../config/database';
import { ModelPrice } from '@prisma/client';

/**
 * 计费引擎：依据 ModelPrice 价格表 + 火山标准计费公式计算单次调用费用。
 * 返回费用、单价、计费公式，供调用日志/账单核对展示。
 *
 * 计费标准（对齐火山引擎《模型价格》文档）：
 *  - chat / token：费用 = 输入单价×输入token + 输出单价×输出token
 *  - 视频 / token：token用量 = (输入时长+输出时长)×宽×高×帧率/1024；费用 = token单价×token用量
 *  - 图片 / per_image：费用 = 张数 × 元/张
 * 所有价格均为标准价（不含限时折扣）。
 */

export interface CostResult {
  cost: number;          // 总费用（元，保留 6 位）
  unit: string;          // 单价描述（如 "输入3.0/输出9.0 元/百万"、"46/28 元/百万"、"0.30 元/张"）
  weightedUnit?: number; // 「金额」：本次调用加权单价（费用/总tokens 或 元/秒）
  formula: string;       // 计费公式文本
  tokensInput?: number;
  tokensOutput?: number;
  totalTokens?: number;  // 视频场景为 token 用量
}

/**
 * 计算费用（优先 ModelPrice 表；找不到时回退到 Model 表原有字段）
 */
export async function computeCost(opts: {
  modelName: string;
  modelType?: string;       // chat / video / image / 3d
  source?: string;          // volcano / local
  tokensInput?: number;
  tokensOutput?: number;
  durationSeconds?: number; // 视频时长
  resolution?: string;      // 视频分辨率 480p/720p/1080p/4k
  fps?: number;             // 视频帧率
  hasInputVideo?: boolean;  // 本次调用是否带输入视频
  inputVideoSeconds?: number; // 输入视频时长
  imageCount?: number;      // 图片张数
  imageHighPixels?: boolean;// 图片是否高像素(>1.5K)
  totalTokensOverride?: number; // 覆盖 token 用量（火山返回的准确 completion_tokens）
}): Promise<CostResult> {
  const modelType = (opts.modelType || 'chat').toLowerCase();

  // 找价格记录：优先精确 modelName，否则尝试模糊匹配
  let price = await prisma.modelPrice.findUnique({ where: { modelKey: opts.modelName } });
  if (!price) {
    price = await findBestPrice(opts.modelName, modelType, opts.resolution, opts.source);
  }

  // 没有价格记录 → 回退到 Model 表逻辑（旧 calcCost 兜底）
  if (!price) {
    return computeLegacy(opts);
  }

  const mode = price.priceMode || 'token';
  const r1m = 1_000_000;

  if (mode === 'per_image') {
    const per = Number(price.perImage ?? 0);
    const perHigh = Number(price.perImageHigh ?? per);
    const unitPrice = opts.imageHighPixels ? perHigh : per;
    const count = opts.imageCount || 1;
    const cost = count * unitPrice;
    return {
      cost: round(cost),
      unit: `${unitPrice.toFixed(2)} 元/张`,
      weightedUnit: unitPrice,
      formula: `${count} 张 × ${unitPrice.toFixed(2)} 元/张`,
    };
  }

  if (mode === 'per_second') {
    const perSec = Number(price.perSecond ?? 0);
    const sec = opts.durationSeconds || 0;
    const cost = sec * perSec;
    return {
      cost: round(cost),
      unit: `${perSec.toFixed(2)} 元/秒`,
      weightedUnit: perSec,
      formula: `${sec} 秒 × ${perSec.toFixed(2)} 元/秒`,
    };
  }

  // token 模式
  if (modelType === 'video' || (price.resolution && price.inputNoVideo != null)) {
    // ─── 视频：token 总量 × token 单价 ───
    const resolution = (opts.resolution || price.resolution || '720p').toLowerCase();
    // 直接用 findBestPrice 定位到的价格记录（已按模型版本+分辨率精确定位，不再二次查询避免覆盖成其他版本）
    const row = price;
    const withVideo = !!opts.hasInputVideo;
    const tokenPrice = withVideo ? Number(row.inputWithVideo ?? row.inputNoVideo ?? 0) : Number(row.inputNoVideo ?? 0);

    // token 用量：优先用火山返回的准确值；否则用估算公式
    const totalTokens = opts.totalTokensOverride && opts.totalTokensOverride > 0
      ? Number(opts.totalTokensOverride)
      : computeVideoTokens(opts).totalTokens;
    const { sec } = computeVideoTokens(opts);
    const cost = tokenPrice * totalTokens / r1m;
    return {
      cost: round(cost),
      unit: `${row.inputNoVideo ?? '—'} / ${row.inputWithVideo ?? '—'} 元/百万 (${resolution}${withVideo ? ' 含视频' : ' 不含'})`,
      weightedUnit: totalTokens > 0 ? round(cost / totalTokens) : 0,
      formula: `${tokenPrice.toFixed(2)} 元/百万 × ${totalTokens} token (${Math.round(sec)}s${opts.totalTokensOverride ? ', 火山准确用量' : ', 估算'})`,
      totalTokens,
    };
  }

  // ─── chat / token：输入×输入价 + 输出×输出价 ───
  const inPrice = Number(price.inputPrice ?? 0);
  const outPrice = Number(price.outputPrice ?? 0);
  const tin = opts.tokensInput || 0;
  const tout = opts.tokensOutput || 0;
  const cost = (inPrice * tin + outPrice * tout) / r1m;
  const totalTokens = tin + tout;
  return {
    cost: round(cost),
    unit: `${fmtPrice(inPrice)} / ${fmtPrice(outPrice)} 元/百万`,
    weightedUnit: totalTokens > 0 ? round(cost / totalTokens * 1_000_000) : 0,
    formula: `(${tin}/1M)×${inPrice.toFixed(2)} + (${tout}/1M)×${outPrice.toFixed(2)}`,
    tokensInput: tin,
    tokensOutput: tout,
    totalTokens,
  };
}

/** 视频 token 用量：token = (输入时长+输出时长) × 宽 × 高 × 帧率 / 1024 */
function computeVideoTokens(opts: { durationSeconds?: number; resolution?: string; inputVideoSeconds?: number; fps?: number }): { totalTokens: number; sec: number } {
  const res = (opts.resolution || '720p').toLowerCase();
  const dims = RES_DIMS[res] || RES_DIMS['720p'];
  const outSec = opts.durationSeconds || 0;
  const inSec = opts.inputVideoSeconds || 0;
  const sec = inSec + outSec;
  const fps = opts.fps || 24;
  const totalTokens = Math.ceil((sec * dims.w * dims.h * fps) / 1024);
  return { totalTokens, sec };
}

// 常见分辨率宽高（16:9）
const RES_DIMS: Record<string, { w: number; h: number }> = {
  '480p': { w: 854, h: 480 },
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '4k': { w: 3840, h: 2160 },
};

/** 找最匹配的价格记录（智能别名匹配：实际模型名 → 价格表 modelKey） */
async function findBestPrice(modelName: string, modelType: string, resolution?: string, source?: string): Promise<ModelPrice | null> {
  const lower = modelName.toLowerCase();

  // 本地模型：视频 → local-video-720p；chat → local-deepseek
  if (source === 'local' || lower.startsWith('local-')) {
    if (modelType === 'video' || lower.includes('video')) {
      return prisma.modelPrice.findUnique({ where: { modelKey: 'local-video-720p' } });
    }
    if (lower.includes('deepseek')) {
      return prisma.modelPrice.findUnique({ where: { modelKey: 'local-deepseek' } });
    }
  }

  // 图片（Seedream）：归一化别名
  if (modelType === 'image' || lower.includes('seedream')) {
    const key = normalizeImageKey(lower);
    if (key) return prisma.modelPrice.findUnique({ where: { modelKey: key } });
  }

  // 视频（Seedance）：按版本 + 分辨率
  if (modelType === 'video' || lower.includes('seedance')) {
    return findVideoPrice(lower, resolution);
  }

  // chat：深度/豆包 seed 系列
  if (modelType === 'chat') {
    // GLM 系列：glm-X-Y → glm-X.Y（点 vs 连字符）
    const glmMatch = lower.match(/glm[\s_-]?(\d+)[\s_.-](\d+)/);
    if (glmMatch) {
      const key = `glm-${glmMatch[1]}.${glmMatch[2]}`;
      const gp = await prisma.modelPrice.findUnique({ where: { modelKey: key } });
      if (gp) return gp;
      // glm-4-5 等文档未列 → 兜底到 glm-4.7 价
      return prisma.modelPrice.findUnique({ where: { modelKey: 'glm-4.7' } });
    }
    if (lower.includes('deepseek')) {
      const isLocal = source === 'local' || lower.startsWith('local');
      if (isLocal) {
        const lk = await prisma.modelPrice.findUnique({ where: { modelKey: 'local-deepseek' } });
        if (lk) return lk;
      }
      // 区分版本：pro 用 pro 价，flash 用 flash 价（正式版优先）
      if (lower.includes('pro')) {
        const p1 = await prisma.modelPrice.findUnique({ where: { modelKey: 'deepseek-v4-pro正式版' } });
        if (p1) return p1;
        return prisma.modelPrice.findUnique({ where: { modelKey: 'deepseek-v4-pro' } });
      }
      // flash / 其他
      const f1 = await prisma.modelPrice.findUnique({ where: { modelKey: 'deepseek-v4-flash正式版' } });
      if (f1) return f1;
      return prisma.modelPrice.findUnique({ where: { modelKey: 'deepseek-v4-flash' } });
    }
    const all = await prisma.modelPrice.findMany({ where: { modelType: 'chat' } });
    // 匹配豆包 seed 系列（doubao-seed-X.Y-* → 价格表 doubao-seed-X.Y 各版本）
    const seedMatchP = priceSeriesMatch(lower, all);
    if (seedMatchP) return seedMatchP;
    // 豆包 1.x / pro 系列归一化: doubao-1-5-pro-32k-250115 → doubao-1.5-pro-32k; doubao-pro-32k-240615 → doubao-pro-32k
    const doubaoNormalized = doubaoMatch(lower, all);
    if (doubaoNormalized) return doubaoNormalized;

    // —— 智能兜底：让无价格记录的模型也有合理单价，避免 legacy 0.01 白送 ——
    // 豆包 1.x 变体（thinking/ui-tars/vision/256k 等）→ 降到同门基础档 doubao-1.5-pro-32k
    if (lower.includes('doubao-1.5') || lower.includes('doubao-1-5') || lower.includes('doubao-vision')) {
      const base = all.find(x => x.modelKey === 'doubao-1.5-pro-32k')
        || all.find(x => x.modelKey === 'doubao-pro-32k');
      if (base) return base;
    }
    // 第三方托管模型（qwen/kimi/mistral/wan/deepseek变体等）→ thirdparty-default
    if (/(qwen|kimi|mistral|wan)/.test(lower)) {
      const tp = await prisma.modelPrice.findUnique({ where: { modelKey: 'thirdparty-default' } });
      if (tp) return tp;
    }
    // 最后的通用降级：任一 chat 价格兜底（用 doubao-1.5-pro-32k）
    const fallback = all.find(x => x.modelKey === 'doubao-1.5-pro-32k') || all[0];
    return fallback || null;
  }
  return null;
}

/** 豆包 1.x/pro 系列: 连字符版本号 → 点号版本号 */
function doubaoMatch(lower: string, all: { modelKey: string }[]): any {
  // doubao-1-5-pro-32k / doubao-1-5-lite-32k → doubao-1.5-pro-32k / doubao-1.5-lite-32k
  const m = lower.match(/doubao-1[.-](\d)-(\w[\w-]*?)-(\d+k)(?:-|$)/);
  if (m) {
    const key = `doubao-1.${m[1]}-${m[2]}-${m[3]}`;
    const p = all.find(x => x.modelKey === key);
    if (p) return p;
    const keyV = `doubao-1.${m[1]}-${m[3]}`; // doubao-1.5-32k 兜底
    return all.find(x => x.modelKey === keyV);
  }
  // doubao-pro-Nk / doubao-pro-Nk-xxx
  const pm = lower.match(/doubao-pro-(\d+k)/);
  if (pm) {
    const key = `doubao-pro-${pm[1]}`;
    return all.find(x => x.modelKey === key) || null;
  }
  return null;
}

/** 豆包 seed 系列匹配：实际名 doubao-seed-2-0-pro-260215 → 价格表 doubao-seed-2.0-pro；
 *  doubao-seed-1-6-flash-250615 → doubao-seed-1.6-flash；seed-character → doubao-seed-character 等 */
function priceSeriesMatch(lower: string, all: { modelKey: string }[]): any {
  // 带版本号: doubao-seed-X-Y(-子型号)-日期
  const m = lower.match(/doubao-seed-(\d+)-(\d+)(-(\w+))?/);
  if (m) {
    const ver = `${m[1]}.${m[2]}`;
    const sub = m[4] ? m[4].replace(/-(\d+)$/, '') : ''; // 去尾部日期段
    const candidates: string[] = [];
    if (sub) candidates.push(`doubao-seed-${ver}-${sub}`); // 2.0-pro / 1.6-flash
    candidates.push(`doubao-seed-${ver}`);                  // 2.0 / 1.6
    for (const key of candidates) {
      const p = all.find(x => x.modelKey === key);
      if (p) return p;
    }
    // 子型号无记录时，同版本回退 base
    const base = all.find(x => x.modelKey === `doubao-seed-${ver}`);
    if (base) return base;
    // 退化到相近版本（1.6→1.8 之类）
    const numVer = `${m[1]}.${m[2]}`;
    const nearby = all.map(x => x.modelKey).filter(k => k.startsWith(`doubao-seed-${m[1]}.`)).sort();
    if (nearby.length) {
      return all.find(x => x.modelKey === nearby[nearby.length - 1]);
    }
  }
  // 无版本号: doubao-seed-character/code/evolving/translation 等
  for (const suf of ['character', 'code', 'evolving', 'translation']) {
    if (lower.includes(`seed-${suf}`) || lower.includes(`seed${suf}`)) {
      const p = all.find(x => x.modelKey === `doubao-seed-${suf}`);
      if (p) return p;
    }
  }
  return null;
}

/** 图片模型名 → 价格表 modelKey（虚名映射） */
function normalizeImageKey(lower: string): string | null {
  if (lower.includes('seedream-5-0') || lower.includes('seedream5.0') || lower.includes('seedream_5_0')) {
    if (lower.includes('lite')) return 'doubao-seedream-5-0-lite';
    return 'doubao-seedream-5-0-pro';
  }
  if (lower.includes('seedream-4-5') || lower.includes('seedream4.5')) return 'doubao-seedream-4-5';
  if (lower.includes('seedream-4-0') || lower.includes('seedream4.0')) return 'doubao-seedream-4-0';
  if (lower.includes('seedream-5-0')) return 'doubao-seedream-5-0-pro';
  return null;
}

/** 视频模型名 → 价格记录（按版本 + 分辨率） */
async function findVideoPrice(lower: string, resolution?: string): Promise<ModelPrice | null> {
  const res = (resolution || '720p').toLowerCase();
  // 本地视频
  if (lower.startsWith('local') || lower.includes('local-video')) {
    return prisma.modelPrice.findUnique({ where: { modelKey: 'local-video-720p' } });
  }
  // seedance-2.5
  if (lower.includes('seedance-2-5') || lower.includes('seedance2.5') || lower.includes('seedance_2_5')) {
    return findSeedanceVersion('doubao-seedance-2.5', res);
  }
  // seedance-2-0-mini
  if (lower.includes('seedance-2-0-mini') || lower.includes('seedance-2.0-mini')) {
    return findSeedanceVersion('doubao-seedance-2.0-mini', res, ['480p', '720p']);
  }
  // seedance-2-0-fast
  if (lower.includes('seedance-2-0-fast') || lower.includes('seedance-2.0-fast')) {
    return findSeedanceVersion('doubao-seedance-2.0-fast', res, ['480p', '720p']);
  }
  if (lower.includes('seedance-2-0') || lower.includes('seedance2.0')) {
    return findSeedanceVersion('doubao-seedance-2.0', res);
  }
  // seedance-2-0（标准）
  if (lower.includes('seedance-2-0') || lower.includes('seedance2.0')) {
    return findSeedanceVersion('doubao-seedance-2.0', res);
  }
  // 其他旧版（1.x）回退到 seedance-2.0
  return findSeedanceVersion('doubao-seedance-2.0', res);
}

async function findSeedanceVersion(base: string, res: string, supported?: string[]): Promise<ModelPrice | null> {
  const key = `${base}-${res}`;
  const p = await prisma.modelPrice.findUnique({ where: { modelKey: key } });
  if (p) return p;
  // 该分辨率不受支持（如 fast/mini 不支持 1080p）→ 回退 720p
  if (supported && !supported.includes(res)) {
    return prisma.modelPrice.findUnique({ where: { modelKey: `${base}-720p` } });
  }
  return p || prisma.modelPrice.findUnique({ where: { modelKey: `${base}-720p` } });
}

/** 回退：Model 表旧字段计费 */
async function computeLegacy(opts: any): Promise<CostResult> {
  const model = await prisma.model.findUnique({ where: { name: opts.modelName } });
  const per1mIn = Number(model?.per1mInputTokens || 0);
  const per1mOut = Number(model?.per1mOutputTokens || 0);
  const tin = opts.tokensInput || 0, tout = opts.tokensOutput || 0;
  if ((per1mIn > 0 || per1mOut > 0) && (tin > 0 || tout > 0)) {
    const cost = (per1mIn * tin + per1mOut * tout) / 1_000_000;
    return { cost: round(cost), unit: `${per1mIn}/${per1mOut} 元/百万`, weightedUnit: 0, formula: `旧计费 (${tin}/${tout} tokens)`, tokensInput: tin, tokensOutput: tout };
  }
  const perSec = Number(model?.unitCostPerSecond || 0);
  const dur = opts.durationSeconds || 0;
  if (perSec > 0 && dur > 0) {
    const cost = dur * perSec;
    return { cost: round(cost), unit: `${perSec} 元/秒`, weightedUnit: perSec, formula: `${dur}×${perSec} 元/秒` };
  }
  const perCall = Number(model?.unitCost || 0.1);
  return { cost: round(perCall), unit: `${perCall} 元/次`, weightedUnit: perCall, formula: `按次 ${perCall} 元` };
}

function fmtPrice(v: number): string {
  return v ? v.toFixed(2) : '—';
}
function round(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

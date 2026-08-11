import dotenv from 'dotenv';
dotenv.config();

// globalThis 类型扩展
declare global {
  var __codeStore: Map<string, { code: string; expires: number }> | undefined;
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    url: process.env.DATABASE_URL || 'postgresql://suzhenzhong@localhost:5432/maas_platform',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'maas-jwt-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'maas-refresh-secret',
    expiresIn: '1h',
    refreshExpiresIn: '7d',
  },
  apiKey: {
    encryptionKey: process.env.API_KEY_ENCRYPTION_KEY || 'maas-aes-key-32bytes-change-me!!',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  system: {
    registrationEnabled: true,
    defaultQuota: 100.00,
    callRateLimit: 60,
    tokenRetentionDays: 365,
  },
  /** 模型同步端点配置（从环境变量读取，逗号分隔） */
  sync: {
    /** Ollama 端点列表，如 "http://localhost:11434,http://192.168.1.100:11434" */
    ollamaEndpoints: parseEndpoints(process.env.OLLAMA_ENDPOINTS, ['http://localhost:11434']),
    /** vLLM / OpenAI 兼容端点，格式: "label1=http://host:8000,label2=http://host:8001" */
    vllmEndpoints: parseLabeledEndpoints(process.env.VLLM_ENDPOINTS),
    /** Diffusers 端点，格式: "SD WebUI=http://host:7860@sdwebui,ComfyUI=http://host:8188@comfyui" */
    diffusersEndpoints: parseDiffusersEndpoints(process.env.DIFFUSERS_ENDPOINTS),
    /** 同步间隔（秒），默认 3 小时（10800）；避免每 60 秒全量写库拖慢数据库 */
    intervalMs: parseInt(process.env.MODEL_SYNC_INTERVAL || '10800', 10) * 1000,
  },
};

// ── 环境变量解析工具函数 ──

/** 简单逗号分隔的端点 */
function parseEndpoints(raw?: string, defaults?: string[]): string[] {
  if (!raw) return defaults || [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** 带 label 的端点，格式: label1=url1,label2=url2 */
function parseLabeledEndpoints(raw?: string): { endpoint: string; label: string }[] {
  if (!raw) return [];
  return raw.split(',').map(s => {
    const [label, endpoint] = s.split('=');
    return { label: label.trim(), endpoint: endpoint.trim() };
  }).filter(item => item.endpoint);
}

/** Diffusers 端点，格式: label=url@type,label=url@type */
function parseDiffusersEndpoints(raw?: string): { endpoint: string; label: string; type: 'sdwebui' | 'comfyui' }[] {
  if (!raw) return [];
  return raw.split(',').map(s => {
    const [label, rest] = s.split('=');
    const parts = rest?.split('@') || [];
    return {
      label: label.trim(),
      endpoint: parts[0]?.trim() || '',
      type: (parts[1]?.trim() || 'sdwebui') as 'sdwebui' | 'comfyui',
    };
  }).filter(item => item.endpoint);
}

// 启动时校验关键配置
const REQUIRED_ENV_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'API_KEY_ENCRYPTION_KEY'];
export function validateConfig(): void {
  const warnings: string[] = [];
  for (const key of REQUIRED_ENV_KEYS) {
    if (!process.env[key]) {
      warnings.push(key);
    }
  }
  if (warnings.length > 0 && config.nodeEnv === 'production') {
    throw new Error(
      `❌ 安全配置缺失 (生产环境禁止使用默认值): ${warnings.join(', ')}。\n` +
      '请在 .env 文件中设置这些环境变量后再启动。'
    );
  }
  if (warnings.length > 0) {
    console.warn(`⚠️  警告：以下密钥使用了默认值（仅开发环境可用）: ${warnings.join(', ')}`);
  }
}
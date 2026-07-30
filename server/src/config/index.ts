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
};

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
import { FastifyInstance } from 'fastify';
import prisma from '../config/database';
import { adminAuth } from '../middleware/auth';
import { encryptApiKey, decryptApiKey } from '../utils/apiKey';

// 系统设置中需要通过加密存储的 key
const SECRET_KEYS = ['volcano_api_key', 'volcano_ak', 'volcano_sk', 'turnstile_secret_key'];

export default async function settingsRoutes(app: FastifyInstance) {
  // 公开接口：获取注册所需的公开配置（Turnstile Site Key 等）
  app.get('/api/v1/public/settings', async () => {
    const siteKey = await prisma.systemSetting.findUnique({ where: { key: 'turnstile_site_key' } });
    const regEnabled = await prisma.systemSetting.findUnique({ where: { key: 'registration_enabled' } });
    return {
      success: true,
      data: {
        turnstileSiteKey: siteKey?.value || null,
        registrationEnabled: regEnabled?.value !== 'false',
      },
    };
  });
  // 获取所有系统配置（敏感字段脱敏显示）
  app.get('/api/v1/admin/settings', { preHandler: [adminAuth] }, async (request, reply) => {
    const all = await prisma.systemSetting.findMany({ orderBy: { updatedAt: 'desc' } });

    const data = all.map((item) => {
      let display = item.value || '';
      if (SECRET_KEYS.includes(item.key) && display) {
        // 解密后脱敏：只显示前后各4位
        // 兼容历史数据：如果解密失败，说明是明文存储，直接脱敏
        try {
          const decrypted = decryptApiKey(display);
          if (decrypted.length > 8) {
            display = decrypted.slice(0, 4) + '****' + decrypted.slice(-4);
          } else {
            display = decrypted.substring(0, 3) + '***';
          }
        } catch {
          // 解密失败 — 可能是历史明文数据
          if (display.length > 8) {
            display = display.slice(0, 4) + '****' + display.slice(-4);
          } else {
            display = '******';
          }
        }
        return { ...item, value: display, masked: true };
      }
      return { ...item, value: display };
    });

    return { success: true, data };
  });

  // 保存/更新单个配置
  app.put('/api/v1/admin/settings', { preHandler: [adminAuth] }, async (request, reply) => {
    const { key, value } = request.body as { key: string; value: string };
    if (!key) {
      return reply.status(400).send({ success: false, error: { code: 'MISSING_KEY', message: '请指定配置项 key' } });
    }

    // 校验系统参数格式
    if (key === 'call_rate_limit' && value && (isNaN(Number(value)) || Number(value) < 1)) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '调用频率必须是大于0的整数' } });
    }
    if (key === 'token_retention_days' && value && (isNaN(Number(value)) || Number(value) < 1)) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '保留天数必须是大于0的整数' } });
    }
    if (key === 'registration_enabled' && value && !['true', 'false'].includes(value)) {
      return reply.status(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: '开放注册取值必须是 true 或 false' } });
    }

    let storedValue = value;
    if (SECRET_KEYS.includes(key) && value) {
      storedValue = encryptApiKey(storedValue);
    }

    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: storedValue, updatedAt: new Date() },
      create: {
        key,
        value: storedValue,
        type: SECRET_KEYS.includes(key) ? 'secret' : 'string',
        description: getDescription(key),
      },
    });

    return { success: true, message: '配置已保存' };
  });

  // 删除配置
  app.delete('/api/v1/admin/settings/:key', { preHandler: [adminAuth] }, async (request, reply) => {
    const { key } = request.params as { key: string };
    try {
      await prisma.systemSetting.delete({ where: { key } });
    } catch (err: any) {
      if (err?.code === 'P2025') {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: '配置项不存在' } });
      }
      throw err;
    }
    return { success: true, message: '配置已删除' };
  });
}

function getDescription(key: string): string {
  const map: Record<string, string> = {
    volcano_api_key: '火山引擎 API Key — 用于视频/图片生成（Seedance/Seedream）',
    volcano_ak: '火山引擎 Access Key — 素材管理签名',
    volcano_sk: '火山引擎 Secret Key — 素材管理签名',
    volcano_project_name: '项目名称',
    turnstile_site_key: 'Cloudflare Turnstile Site Key — 前端人机验证（公开）',
    turnstile_secret_key: 'Cloudflare Turnstile Secret Key — 后端验证密钥',
    registration_enabled: '是否开放用户注册',
    call_rate_limit: '每分钟最大调用次数',
    token_retention_days: '调用日志保留天数',
  };
  return map[key] || '';
}
/**
 * 模型同步定时任务 — 每隔一段时间扫描自部署模型和火山引擎模型
 *
 * 轻量实现，不依赖 BullMQ，通过 setInterval 运行
 * 在生产环境可替换为 BullMQ 重复任务
 */

import { syncModels, DiffusersEndpoint } from './model-sync';

let intervalId: ReturnType<typeof setInterval> | null = null;

export interface SyncCronOptions {
  intervalMs?: number;
  ollamaEndpoints?: string[];
  vllmEndpoints?: { endpoint: string; label: string; modelTypes?: Record<string, string> }[];
  diffusersEndpoints?: DiffusersEndpoint[];
}

/**
 * 启动模型同步定时任务
 */
export function startModelSyncCron(options?: SyncCronOptions) {
  if (intervalId) {
    console.warn('[model-sync-cron] 已有定时任务在运行，跳过');
    return;
  }

  const intervalMs = options?.intervalMs ?? 60000;
  const ollamaEndpoints = options?.ollamaEndpoints || [];
  const vllmEndpoints = options?.vllmEndpoints || [];
  const diffusersEndpoints = options?.diffusersEndpoints || [];

  console.log(`[model-sync-cron] 启动定时同步（每 ${intervalMs / 1000} 秒）`);
  console.log(`[model-sync-cron] Ollama 端点: ${ollamaEndpoints.join(', ') || '无'}`);
  console.log(`[model-sync-cron] vLLM 端点: ${vllmEndpoints.map(v => v.label + '=' + v.endpoint).join(', ') || '无'}`);
  console.log(`[model-sync-cron] Diffusers 端点: ${diffusersEndpoints.map(d => d.label + '=' + d.endpoint).join(', ') || '无'}`);

  // 启动时立即同步一次（包含火山引擎模型）
  syncModels({ ollamaEndpoints, vllmEndpoints, diffusersEndpoints, includeVolcano: true }).catch((err) => {
    console.error('[model-sync-cron] 启动同步失败:', err);
  });

  // 定时同步
  intervalId = setInterval(() => {
    syncModels({ ollamaEndpoints, vllmEndpoints, diffusersEndpoints, includeVolcano: true }).catch((err) => {
      console.error('[model-sync-cron] 定时同步失败:', err);
    });
  }, intervalMs);
}

/**
 * 停止模型同步定时任务
 */
export function stopModelSyncCron() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[model-sync-cron] 已停止');
  }
}

/**
 * 模型同步定时任务 — 每隔一段时间扫描自部署模型
 *
 * 轻量实现，不依赖 BullMQ，通过 setInterval 运行
 * 在生产环境可替换为 BullMQ 重复任务
 */

import { syncModels } from './model-sync';

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * 启动模型同步定时任务
 * @param intervalMs 扫描间隔（毫秒），默认 60000（1分钟）
 * @param ollamaEndpoints Ollama 端点列表
 * @param vllmEndpoints vLLM/OpenAI 兼容端点列表
 */
export function startModelSyncCron(
  intervalMs: number = 60000,
  ollamaEndpoints: string[] = ['http://localhost:11434'],
  vllmEndpoints: { endpoint: string; label: string }[] = []
) {
  if (intervalId) {
    console.warn('[model-sync-cron] 已有定时任务在运行，跳过');
    return;
  }

  console.log(`[model-sync-cron] 启动定时同步（每 ${intervalMs / 1000} 秒）`);
  console.log(`[model-sync-cron] Ollama 端点: ${ollamaEndpoints.join(', ') || '无'}`);
  console.log(
    `[model-sync-cron] vLLM 端点: ${vllmEndpoints.map(v => v.endpoint).join(', ') || '无'}`
  );

  // 启动时立即同步一次
  syncModels({ ollamaEndpoints, vllmEndpoints }).catch((err) => {
    console.error('[model-sync-cron] 启动同步失败:', err);
  });

  // 定时同步
  intervalId = setInterval(() => {
    syncModels({ ollamaEndpoints, vllmEndpoints }).catch((err) => {
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

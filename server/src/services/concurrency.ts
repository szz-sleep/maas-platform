/**
 * 并发信号量 — 限制同时进行的火山生成/创建请求数量
 *
 * 核心设计：
 *   - 限制"同时发起创建请求"的并发数为 limit（不是等待火山生成完成）
 *   - 超过 limit 的请求排队等待空位（acquire 会阻塞等待释放）
 *   - 提供等待超时，超时返回 null 表示未拿到许可（避免无限排队）
 *
 * 使用方式：
 *   const semaphore = new Semaphore(5);
 *   const release = await semaphore.acquire(30000);  // 超时3万ms
 *   if (!release) return 繁忙;
 *   try { ...调用火山... } finally { release(); }
 */
export class Semaphore {
  private current: number;
  private queue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private limit: number) {
    this.current = 0;
  }

  /**
   * 尝试获取一个许可。
   * @param timeoutMs 排队等待超时（毫秒），超过则返回 null（需放弃本次请求）
   * @returns 释放函数；若获取失败（超时）返回 null
   */
  acquire(timeoutMs: number): Promise<(() => void) | null> {
    if (this.current < this.limit) {
      this.current++;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 从队列中移除自己
        this.queue = this.queue.filter((q) => q.resolve !== onRelease);
        resolve(null); // 超时未拿到许可
      }, timeoutMs);

      const onRelease = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.current++;
        resolve(this.createRelease());
      };

      this.queue.push({ resolve: onRelease, timer });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.current--;
      // 唤醒队列中下一个等待者（FIFO）
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      }
    };
  }
}

// 全局默认信号量：限制同时进行的创建/生成请求数
export const volcanoSemaphore = new Semaphore(5);

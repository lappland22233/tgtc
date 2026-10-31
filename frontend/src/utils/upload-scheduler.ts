/**
 * 全局上传并发调度器（令牌池单例，p-limit 风格，无第三方依赖）。
 *
 * 所有分片上传请求（useChunkedUpload）在发起 axios 请求前必须先 acquire() 令牌，
 * 请求结束后 release()。由此把"文件级并发 × 分片级并发"的乘积收敛为
 * 全局统一的在途上传请求上限，避免超出浏览器同 origin 6 连接限制导致
 * 请求排队挂起、超时误判级联。
 */

/**
 * 默认全局并发上传请求数。
 * 浏览器对同 origin 的 HTTP/1.1 并发连接上限为 6，这里取 4，
 * 预留 2 条连接给业务 API 调用与上传状态轮询（upload-status / chunk status），
 * 防止上传把连接占满后其余请求全部排队挂起。
 */
export const UPLOAD_CONCURRENCY_DEFAULT = 4;

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  /** 已被授予令牌或已取消（防止重复结算） */
  settled: boolean;
  cleanup: () => void;
}

class UploadScheduler {
  private concurrency = UPLOAD_CONCURRENCY_DEFAULT;
  private active = 0;
  /** FIFO 等待队列 */
  private queue: Waiter[] = [];

  /** 获取一个上传令牌；并发已满时进入可取消的 FIFO 队列 */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('上传已取消'));
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        waiter.settled = true;
        waiter.cleanup();
        this.removeWaiter(waiter);
        reject(new Error('上传已取消'));
      };
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 归还令牌：直接移交给 FIFO 队首等待者（active 不变），无等待者时计数减一 */
  release(): void {
    const waiter = this.active <= this.concurrency ? this.shiftNextWaiter() : undefined;
    if (waiter) {
      waiter.settled = true;
      waiter.cleanup();
      waiter.resolve();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  /** 运行时调整并发上限（clamp 到 1-8）；上调时立即把新增槽位授予等待者 */
  setConcurrency(n: number): void {
    const next = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(n)));
    this.concurrency = next;
    while (this.active < this.concurrency) {
      const waiter = this.shiftNextWaiter();
      if (!waiter) break;
      this.active++;
      waiter.settled = true;
      waiter.cleanup();
      waiter.resolve();
    }
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getActiveCount(): number {
    return this.active;
  }

  /** 取出第一个未结算的等待者 */
  private shiftNextWaiter(): Waiter | undefined {
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (!waiter.settled) return waiter;
    }
    return undefined;
  }

  private removeWaiter(waiter: Waiter): void {
    const idx = this.queue.indexOf(waiter);
    if (idx !== -1) this.queue.splice(idx, 1);
  }
}

/** 全局单例：所有上传请求共享同一个令牌池 */
export const uploadScheduler = new UploadScheduler();

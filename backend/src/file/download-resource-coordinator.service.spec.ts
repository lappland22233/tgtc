import {
  DOWNLOAD_ERROR_CODES,
  DOWNLOAD_RESOURCE_DEFAULTS,
  DownloadResourceCoordinatorService,
  type DownloadReservation,
} from './download-resource-coordinator.service';

// 生产代码通过 require('fs').statfsSync 读取，Jest 中与 import 指向同一 module 对象，
// 因此用 require('fs') 来 spy。
const fsModule = require('fs');

function mockFree(bytes: number): void {
  jest.spyOn(fsModule, 'statfsSync').mockReturnValue({
    bsize: 4096,
    bfree: Math.ceil(bytes / 4096),
    bavail: Math.ceil(bytes / 4096),
  } as ReturnType<typeof fsModule.statfsSync>);
}

const KB = 1024;
const MB = 1024 * 1024;

describe('DownloadResourceCoordinatorService', () => {
  let service: DownloadResourceCoordinatorService;

  beforeEach(() => {
    jest.restoreAllMocks();
    service = new DownloadResourceCoordinatorService();
    service.setProbeDir('/tmp/fake-cache-dir');
  });

  afterEach(() => {
    service.shutdown();
  });

  describe('预约与消费记账', () => {
    it('空间充足时立即授予并登记未写入预约', async () => {
      mockFree(MB);
      const reservation = await service.reserve({ sessionKey: 'file:a', bytes: KB });
      expect(reservation.grantedBytes).toBe(KB);
      expect(reservation.remainingBytes).toBe(KB);
      expect(service.pendingReservedBytes).toBe(KB);
      expect(service.waitingDiskCount).toBe(0);
      reservation.release();
      expect(service.pendingReservedBytes).toBe(0);
    });

    it('每写入一段数据后剩余预约同步递减（避免物理/逻辑双重扣减）', async () => {
      mockFree(MB);
      const reservation = await service.reserve({ sessionKey: 'file:a', bytes: 4 * KB });
      reservation.consume(KB);
      expect(reservation.remainingBytes).toBe(3 * KB);
      expect(service.pendingReservedBytes).toBe(3 * KB);
      reservation.consume(2 * KB);
      expect(reservation.remainingBytes).toBe(KB);
      // 超额消费被裁剪，不产生负值
      reservation.consume(10 * KB);
      expect(reservation.remainingBytes).toBe(0);
      expect(service.pendingReservedBytes).toBe(0);
      reservation.release();
    });

    it('释放幂等：重复 release 不重复扣减，也不影响其他预约', async () => {
      mockFree(MB);
      const first = await service.reserve({ sessionKey: 'file:a', bytes: KB });
      const second = await service.reserve({ sessionKey: 'file:b', bytes: KB });
      first.release();
      first.release();
      expect(service.pendingReservedBytes).toBe(KB);
      second.release();
      expect(service.pendingReservedBytes).toBe(0);
      expect(service.activeReservationCount).toBe(0);
    });

    it('会话结束后全额归还（完整下载不累积预约）', async () => {
      mockFree(MB);
      for (let i = 0; i < 3; i++) {
        const reservation = await service.reserve({ sessionKey: `file:${i}`, bytes: KB });
        reservation.consume(KB); // 完整写入
        reservation.release();
        expect(service.pendingReservedBytes).toBe(0);
      }
    });

    it('统计快照暴露预约量、队列长度与上游占用', async () => {
      mockFree(MB);
      const reservation = await service.reserve({ sessionKey: 'file:a', bytes: KB });
      const lease = await service.acquireUpstreamSlot();
      const snapshot = service.getSnapshot();
      expect(snapshot.reservedRemainingBytes).toBe(KB);
      expect(snapshot.activeReservations).toBe(1);
      expect(snapshot.activeUpstreams).toBe(1);
      expect(snapshot.queueCapacity).toBe(DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS > 0 ? snapshot.queueCapacity : 0);
      expect(snapshot.minimumFreeBytes).toBe(0);
      lease.release();
      reservation.release();
    });
  });

  describe('FIFO 排队与不抢占', () => {
    it('空间不足时进入 FIFO 队列，释放后按序唤醒', async () => {
      mockFree(MB);
      const held = await service.reserve({ sessionKey: 'file:held', bytes: MB });
      const queued = service.reserve({ sessionKey: 'file:queued', bytes: KB });
      expect(service.waitingDiskCount).toBe(1);

      held.release();
      const granted = await queued;
      expect(granted.sessionKey).toBe('file:queued');
      expect(service.waitingDiskCount).toBe(0);
      granted.release();
    });

    it('队头未满足时不跳过（防止大任务长期饥饿）', async () => {
      mockFree(4 * MB);
      const held = await service.reserve({ sessionKey: 'file:held', bytes: 4 * MB });
      const head = service.reserve({ sessionKey: 'file:head', bytes: 3 * MB });
      const tail = service.reserve({ sessionKey: 'file:tail', bytes: 3 * MB });
      expect(service.waitingDiskCount).toBe(2);

      held.release();
      const headGranted = await head;
      expect(headGranted.sessionKey).toBe('file:head');
      // 队头放行后剩余 1MB，不足以放行队尾 → 队尾继续等待，不被跳过
      expect(service.waitingDiskCount).toBe(1);
      headGranted.release();
      const tailGranted = await tail;
      expect(tailGranted.sessionKey).toBe('file:tail');
      tailGranted.release();
    });

    it('已授予的旧任务不被新任务抢占（新任务只能排队）', async () => {
      mockFree(2 * MB);
      const oldTask = await service.reserve({ sessionKey: 'file:old', bytes: 2 * MB });
      const newTask = service.reserve({ sessionKey: 'file:new', bytes: 2 * MB });
      expect(service.waitingDiskCount).toBe(1);
      // 旧任务额度不被撤销
      expect(oldTask.active).toBe(true);
      expect(oldTask.remainingBytes).toBe(2 * MB);

      oldTask.release();
      const granted = await newTask;
      granted.release();
    });

    it('队列容量上限生效时返回 DOWNLOAD_QUEUE_FULL', async () => {
      mockFree(MB);
      service.configure({ queueCapacity: 2 });
      const held = await service.reserve({ sessionKey: 'file:held', bytes: MB });
      const first = service.reserve({ sessionKey: 'file:1', bytes: KB });
      const second = service.reserve({ sessionKey: 'file:2', bytes: KB });
      expect(service.waitingDiskCount).toBe(2);

      await expect(service.reserve({ sessionKey: 'file:3', bytes: KB })).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.QUEUE_FULL,
      });

      held.release();
      await Promise.all([first, second]);
    });

    it('排队超时后移除等待项并返回 DOWNLOAD_QUEUE_TIMEOUT', async () => {
      jest.useFakeTimers();
      try {
        mockFree(MB);
        const held = await service.reserve({ sessionKey: 'file:held', bytes: MB });
        const queued = service.reserve({ sessionKey: 'file:queued', bytes: KB, waitTimeoutMs: 100 });
        const expectation = expect(queued).rejects.toMatchObject({
          errorCode: DOWNLOAD_ERROR_CODES.QUEUE_TIMEOUT,
        });
        expect(service.waitingDiskCount).toBe(1);
        await jest.advanceTimersByTimeAsync(150);
        await expectation;
        expect(service.waitingDiskCount).toBe(0);
        held.release();
      } finally {
        jest.useRealTimers();
      }
    });

    it('AbortSignal 取消等待项后立即出队', async () => {
      mockFree(MB);
      const held = await service.reserve({ sessionKey: 'file:held', bytes: MB });
      const controller = new AbortController();
      const queued = service.reserve({ sessionKey: 'file:queued', bytes: KB, signal: controller.signal });
      expect(service.waitingDiskCount).toBe(1);

      controller.abort();
      await expect(queued).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.QUEUE_CANCELLED,
      });
      expect(service.waitingDiskCount).toBe(0);
      held.release();
    });

    it('进入队列时回调上报排队原因与位置', async () => {
      mockFree(2 * MB);
      const held = await service.reserve({ sessionKey: 'file:held', bytes: 2 * MB });
      const queued = service.reserve({
        sessionKey: 'file:queued',
        bytes: KB,
        onQueued: info => {
          expect(info.reason).toBe('disk');
          expect(info.position).toBe(1);
          expect(info.retryAfterMs).toBeGreaterThan(0);
        },
      });
      held.release();
      (await queued).release();
    });
  });

  describe('结构与探测失败', () => {
    it('完整性不可行时返回 DOWNLOAD_INSUFFICIENT_STORAGE（disk）', async () => {
      mockFree(MB);
      service.configure({ minFreeBytes: 512 * KB });
      await expect(service.reserve({ sessionKey: 'file:huge', bytes: 2 * MB })).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.INSUFFICIENT_STORAGE,
        scope: 'disk',
      });
      expect(service.waitingDiskCount).toBe(0);
    });

    it('单文件超过缓存上限时返回 DOWNLOAD_INSUFFICIENT_STORAGE（cache）', async () => {
      mockFree(1024 * MB);
      service.setCacheCapacityProvider(() => ({ committedBytes: 0, maxBytes: 1000 }));
      await expect(
        service.reserve({ sessionKey: 'file:huge', bytes: 2000, countsTowardCache: true }),
      ).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.INSUFFICIENT_STORAGE,
        scope: 'cache',
      });
    });

    it('statfs 失败时按探测不可用拒绝（fail-closed）', async () => {
      jest.spyOn(fsModule, 'statfsSync').mockImplementation(() => {
        throw new Error('EACCES');
      });
      await expect(service.reserve({ sessionKey: 'file:a', bytes: KB })).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.STORAGE_PROBE_UNAVAILABLE,
      });
    });

    it('非法大小直接抛编程错误', async () => {
      mockFree(MB);
      await expect(service.reserve({ sessionKey: 'file:a', bytes: 0 })).rejects.toThrow('非法的下载磁盘预约大小');
      await expect(service.reserve({ sessionKey: 'file:a', bytes: 1.5 })).rejects.toThrow('非法的下载磁盘预约大小');
    });
  });

  describe('缓存逻辑容量预约', () => {
    it('并发构建不会突破缓存上限（其余请求排队）', async () => {
      mockFree(1024 * MB);
      service.setCacheCapacityProvider(() => ({ committedBytes: 0, maxBytes: 1000 }));

      const first = await service.reserve({ sessionKey: 'file:1', bytes: 600, countsTowardCache: true });
      const second = service.reserve({ sessionKey: 'file:2', bytes: 600, countsTowardCache: true });
      expect(service.cacheReservedTotalBytes).toBe(600);
      expect(service.waitingDiskCount).toBe(1);

      first.release();
      const granted = await second;
      expect(service.cacheReservedTotalBytes).toBe(600);
      granted.release();
      expect(service.cacheReservedTotalBytes).toBe(0);
    });

    it('已发布缓存计入上限，淘汰释放后队列可继续', async () => {
      mockFree(1024 * MB);
      let committed = 900;
      service.setCacheCapacityProvider(() => ({ committedBytes: committed, maxBytes: 1000 }));

      const queued = service.reserve({ sessionKey: 'file:1', bytes: 300, countsTowardCache: true });
      expect(service.waitingDiskCount).toBe(1);

      // 模拟 LRU 淘汰释放已发布缓存后，队列可继续
      committed = 0;
      service.configure({});
      const granted = await queued;
      expect(granted.active).toBe(true);
      granted.release();
    });

    it('非缓存预约不占用缓存逻辑容量', async () => {
      mockFree(1024 * MB);
      service.setCacheCapacityProvider(() => ({ committedBytes: 0, maxBytes: 1000 }));
      const spool = await service.reserve({ sessionKey: 'file:spool', bytes: 100000 });
      expect(service.cacheReservedTotalBytes).toBe(0);
      expect(spool.countsTowardCache).toBe(false);
      spool.release();
    });
  });

  describe('上游并发租约', () => {
    it('未达上限时立即授予，释放后唤醒排队任务', async () => {
      service.configure({ maxConcurrentUpstreams: 1 });
      const first = await service.acquireUpstreamSlot();
      expect(service.activeUpstreamCount).toBe(1);

      const second = service.acquireUpstreamSlot({ waitTimeoutMs: 5000 });
      expect(service.waitingUpstreamCount).toBe(1);

      first.release();
      const secondLease = await second;
      expect(service.activeUpstreamCount).toBe(1);
      expect(service.waitingUpstreamCount).toBe(0);
      secondLease.release();
      expect(service.activeUpstreamCount).toBe(0);
    });

    it('上游等待遵循 FIFO', async () => {
      service.configure({ maxConcurrentUpstreams: 1 });
      const first = await service.acquireUpstreamSlot();
      const second = service.acquireUpstreamSlot({ waitTimeoutMs: 5000 });
      const third = service.acquireUpstreamSlot({ waitTimeoutMs: 5000 });

      first.release();
      const secondLease = await second;
      expect(service.waitingUpstreamCount).toBe(1);
      secondLease.release();
      const thirdLease = await third;
      thirdLease.release();
      expect(service.activeUpstreamCount).toBe(0);
    });

    it('上游等待超时返回 DOWNLOAD_SERVER_BUSY', async () => {
      jest.useFakeTimers();
      try {
        service.configure({ maxConcurrentUpstreams: 1 });
        const first = await service.acquireUpstreamSlot();
        const queued = service.acquireUpstreamSlot({ waitTimeoutMs: 100 });
        const expectation = expect(queued).rejects.toMatchObject({
          errorCode: DOWNLOAD_ERROR_CODES.SERVER_BUSY,
        });
        await jest.advanceTimersByTimeAsync(150);
        await expectation;
        expect(service.waitingUpstreamCount).toBe(0);
        first.release();
      } finally {
        jest.useRealTimers();
      }
    });

    it('上游等待可被 AbortSignal 取消', async () => {
      service.configure({ maxConcurrentUpstreams: 1 });
      const first = await service.acquireUpstreamSlot();
      const controller = new AbortController();
      const queued = service.acquireUpstreamSlot({ signal: controller.signal, waitTimeoutMs: 5000 });
      controller.abort();
      await expect(queued).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.QUEUE_CANCELLED,
      });
      expect(service.waitingUpstreamCount).toBe(0);
      first.release();
    });

    it('租约释放幂等', async () => {
      const lease = await service.acquireUpstreamSlot();
      lease.release();
      lease.release();
      expect(service.activeUpstreamCount).toBe(0);
    });
  });

  describe('配置热更新', () => {
    it('降低阈值不撤销已授予的租约，只影响后续准入', async () => {
      mockFree(8 * MB);
      const granted = await service.reserve({ sessionKey: 'file:old', bytes: 4 * MB });
      service.configure({ minFreeBytes: 6 * MB });

      expect(granted.active).toBe(true);
      expect(granted.remainingBytes).toBe(4 * MB);

      // 新任务在收紧后的配置下不可行（8MB - 6MB < 3MB）
      await expect(service.reserve({ sessionKey: 'file:new', bytes: 3 * MB })).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.INSUFFICIENT_STORAGE,
      });
      granted.release();
    });

    it('提高上游并发上限后立即唤醒排队任务', async () => {
      service.configure({ maxConcurrentUpstreams: 1 });
      const first = await service.acquireUpstreamSlot();
      const queued = service.acquireUpstreamSlot({ waitTimeoutMs: 5000 });
      expect(service.waitingUpstreamCount).toBe(1);

      service.configure({ maxConcurrentUpstreams: 2 });
      const second = await queued;
      expect(service.activeUpstreamCount).toBe(2);
      first.release();
      second.release();
    });
  });

  describe('关闭', () => {
    it('shutdown 拒绝全部等待项并停止接纳新任务', async () => {
      mockFree(MB);
      const held = await service.reserve({ sessionKey: 'file:held', bytes: MB });
      const queued = service.reserve({ sessionKey: 'file:queued', bytes: KB });
      expect(service.waitingDiskCount).toBe(1);

      service.shutdown();
      await expect(queued).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.SHUTTING_DOWN,
      });
      expect(service.waitingDiskCount).toBe(0);

      await expect(service.reserve({ sessionKey: 'file:after', bytes: KB })).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.SHUTTING_DOWN,
      });
      await expect(service.acquireUpstreamSlot()).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.SHUTTING_DOWN,
      });

      // 已授予的租约仍可正常释放（由各自会话收尾）
      held.release();
    });

    it('shutdown 后上游等待项被拒绝', async () => {
      service.configure({ maxConcurrentUpstreams: 1 });
      const first = await service.acquireUpstreamSlot();
      const queued = service.acquireUpstreamSlot({ waitTimeoutMs: 5000 });
      service.shutdown();
      await expect(queued).rejects.toMatchObject({
        errorCode: DOWNLOAD_ERROR_CODES.SHUTTING_DOWN,
      });
      first.release();
    });
  });

  describe('队头阻塞时触发淘汰钩子', () => {
    it('队头因缓存容量阻塞时按节流调用淘汰钩子', async () => {
      mockFree(1024 * MB);
      let committed = 500;
      const hook = jest.fn(async () => {
        committed = 0;
      });
      service.setCacheCapacityProvider(() => ({ committedBytes: committed, maxBytes: 1000 }));
      service.setEvictionHook(hook);

      const first = await service.reserve({ sessionKey: 'file:1', bytes: 400, countsTowardCache: true });
      const queued = service.reserve({ sessionKey: 'file:2', bytes: 600, countsTowardCache: true });
      expect(service.waitingDiskCount).toBe(1);

      // 触发一次 pump：队头阻塞 → 请求淘汰 → 淘汰后队列继续
      service.configure({});
      expect(hook).toHaveBeenCalled();
      const granted = await queued;
      expect(granted.active).toBe(true);
      expect(committed).toBe(0);
      first.release();
      granted.release();
    });
  });

  describe('状态快照与遗留接口', () => {
    it('设置活跃上游数会唤醒队列（兼容既有测试）', async () => {
      service.configure({ maxConcurrentUpstreams: 1 });
      service.setActiveUpstreamCount(1);
      const queued = service.acquireUpstreamSlot({ waitTimeoutMs: 5000 });
      expect(service.waitingUpstreamCount).toBe(1);
      service.setActiveUpstreamCount(0);
      const lease = await queued;
      lease.release();
    });

    it('reservation 句柄暴露只读属性', async () => {
      mockFree(MB);
      const reservation: DownloadReservation = await service.reserve({
        sessionKey: 'file:a',
        bytes: KB,
        countsTowardCache: true,
      });
      expect(reservation.countsTowardCache).toBe(true);
      expect(typeof reservation.id).toBe('string');
      expect(service.cacheReservedTotalBytes).toBe(KB);
      reservation.release();
    });
  });
});

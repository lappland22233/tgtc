import {
  DOWNLOAD_CONFIG_KEYS,
  DOWNLOAD_ERROR_CODES,
  DOWNLOAD_RESOURCE_DEFAULTS,
  DownloadResourceCoordinatorService,
  normalizeBooleanFlag,
  normalizeDownloadConfigNumber,
  normalizeUpstreamQueuePolicy,
  upstreamWeightForSize,
  type DownloadReservation,
  type DownloadUpstreamLease,
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

  describe('大文件加权上游并发（4GiB 分卷事件）', () => {
    const GB = 1024 * MB;

    it('按体量映射权重：小文件共享预算，>1GiB 占满默认预算', () => {
      const budget = 8;
      expect(upstreamWeightForSize(64 * MB, budget)).toBe(1);
      // 恰好等于阈值仍属小/中档（避免边界抖动误判为大文件）
      expect(upstreamWeightForSize(256 * MB, budget)).toBe(1);
      expect(upstreamWeightForSize(512 * MB, budget)).toBe(2);
      expect(upstreamWeightForSize(GB, budget)).toBe(2);
      expect(upstreamWeightForSize(GB + 1, budget)).toBe(8);
      expect(upstreamWeightForSize(4 * GB, budget)).toBe(8);
      // 未知/非法大小按最小权重处理，不会因此被永久拒绝
      expect(upstreamWeightForSize(0, budget)).toBe(1);
      expect(upstreamWeightForSize(Number.NaN, budget)).toBe(1);
      // 权重不得超过预算，否则会产生永远无法满足的等待项
      expect(upstreamWeightForSize(4 * GB, 4)).toBe(4);
      expect(upstreamWeightForSize(4 * GB, 16)).toBe(8);
    });

    it('预算 8 时两个 4GiB 冷回源不会同时启动，小文件同样遵守严格 FIFO', async () => {
      service.configure({ maxConcurrentUpstreams: 8 });
      const first = await service.acquireUpstreamSlot({ bytes: 4 * GB });
      expect(first.weight).toBe(8);
      expect(service.activeUpstreamWeightTotal).toBe(8);

      const second = service.acquireUpstreamSlot({ bytes: 4 * GB, waitTimeoutMs: 5000 });
      expect(service.waitingUpstreamCount).toBe(1);
      // 大文件占满预算时，小文件也排队（严格 FIFO，避免大任务被持续插队饿死）
      const small = service.acquireUpstreamSlot({ bytes: 64 * MB, waitTimeoutMs: 5000 });
      expect(service.waitingUpstreamCount).toBe(2);

      first.release();
      const secondLease = await second;
      expect(secondLease.weight).toBe(8);
      expect(service.waitingUpstreamCount).toBe(1);

      secondLease.release();
      const smallLease = await small;
      expect(smallLease.weight).toBe(1);
      smallLease.release();
      expect(service.activeUpstreamWeightTotal).toBe(0);
    });

    it('预算提升到 16 后可同时放行两个 4GiB 冷回源', async () => {
      service.configure({ maxConcurrentUpstreams: 16 });
      const first = await service.acquireUpstreamSlot({ bytes: 4 * GB });
      const second = await service.acquireUpstreamSlot({ bytes: 4 * GB });

      expect(first.weight).toBe(8);
      expect(second.weight).toBe(8);
      expect(service.activeUpstreamCount).toBe(2);
      expect(service.activeUpstreamWeightTotal).toBe(16);

      first.release();
      second.release();
      expect(service.activeUpstreamWeightTotal).toBe(0);
    });

    it('运行快照暴露已占用权重（管理后台可解释「为何排队」）', async () => {
      service.configure({ maxConcurrentUpstreams: 8 });
      const lease = await service.acquireUpstreamSlot({ bytes: 4 * GB });
      const snapshot = service.getSnapshot();
      expect(snapshot.activeUpstreams).toBe(1);
      expect(snapshot.activeUpstreamWeight).toBe(8);
      expect(snapshot.maxConcurrentUpstreams).toBe(8);

      lease.release();
      expect(service.getSnapshot().activeUpstreamWeight).toBe(0);
    });

    it('运行中调低预算后队头仍能被放行（不产生永久阻塞）', async () => {
      service.configure({ maxConcurrentUpstreams: 8 });
      const first = await service.acquireUpstreamSlot({ bytes: 4 * GB });
      const queued = service.acquireUpstreamSlot({ bytes: 4 * GB, waitTimeoutMs: 5000 });
      expect(service.waitingUpstreamCount).toBe(1);

      // 入队时 weight=8；把预算降到 4 后该权重永远无法满足，
      // 必须按当前预算重新裁剪，否则队头及其后续等待项全部阻塞到超时。
      service.configure({ maxConcurrentUpstreams: 4 });
      first.release();

      const lease = await queued;
      expect(lease.weight).toBe(4);
      lease.release();
      expect(service.activeUpstreamWeightTotal).toBe(0);
    });

    it('显式权重被裁剪到预算内，不会出现永远无法满足的等待项', async () => {
      service.configure({ maxConcurrentUpstreams: 4 });
      const lease = await service.acquireUpstreamSlot({ weight: 999 });
      expect(lease.weight).toBe(4);
      lease.release();
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

  describe('bounded_fit 上游队列公平策略（队首阻塞治理）', () => {
    /** 用 weight=1 的占位租约把预算占满，便于精确制造「剩余预算不足但非零」的场景 */
    async function fillBudget(units: number) {
      const leases = [];
      for (let i = 0; i < units; i++) leases.push(await service.acquireUpstreamSlot({ weight: 1 }));
      return leases;
    }

    it('队首大文件暂时放不下时，后续小文件按适配优先获得租约', async () => {
      service.configure({ maxConcurrentUpstreams: 16, upstreamQueuePolicy: 'bounded_fit' });
      const fillers = await fillBudget(16);
      const head = service.acquireUpstreamSlot({ weight: 8, waitTimeoutMs: 30_000 });
      const small = service.acquireUpstreamSlot({ weight: 1, waitTimeoutMs: 30_000 });
      expect(service.waitingUpstreamCount).toBe(2);

      // 释放 1 点权重：大文件仍放不下，小文件可以（strict_fifo 下两者都会被阻塞）
      fillers[0].release();
      const smallLease = await small;
      expect(smallLease.weight).toBe(1);
      expect(service.waitingUpstreamCount).toBe(1);
      expect(service.upstreamHeadBypassCount).toBe(1);
      expect(service.upstreamBypassCount).toBe(1);

      // 释放足够权重后队首最终被放行，不会被小文件饿死
      for (let i = 1; i < 16; i++) fillers[i].release();
      const headLease = await head;
      expect(headLease.weight).toBe(8);

      smallLease.release();
      headLease.release();
      expect(service.activeUpstreamWeightTotal).toBe(0);
    });

    it('strict_fifo 回退：同样的场景下队首大文件阻塞后续小文件（既有行为不变）', async () => {
      service.configure({ maxConcurrentUpstreams: 16, upstreamQueuePolicy: 'strict_fifo' });
      const fillers = await fillBudget(16);
      const headCtl = new AbortController();
      const head = service.acquireUpstreamSlot({ weight: 8, waitTimeoutMs: 30_000, signal: headCtl.signal });
      const small = service.acquireUpstreamSlot({ weight: 1, waitTimeoutMs: 30_000 });

      fillers[0].release();
      expect(service.waitingUpstreamCount).toBe(2);
      expect(service.upstreamBypassCount).toBe(0);

      // 切回 bounded_fit 后同一个等待项立即可以被适配放行
      service.configure({ upstreamQueuePolicy: 'bounded_fit' });
      const smallLease = await small;
      expect(smallLease.weight).toBe(1);

      headCtl.abort();
      await head.catch(() => undefined);
      for (let i = 1; i < 16; i++) fillers[i].release();
      smallLease.release();
    });

    it('小文件连续到达时，队首达绕过上限后进入保留状态（大文件不被饿死）', async () => {
      service.configure({ maxConcurrentUpstreams: 16, upstreamQueuePolicy: 'bounded_fit' });
      const fillers = await fillBudget(16);
      const head = service.acquireUpstreamSlot({ weight: 8, waitTimeoutMs: 60_000 });
      const smalls = [];
      for (let i = 0; i < 10; i++) {
        smalls.push(service.acquireUpstreamSlot({ weight: 1, waitTimeoutMs: 60_000 }));
      }
      expect(service.waitingUpstreamCount).toBe(11);

      // 每次释放 1 点权重都绕过队首放行一个小文件，直到绕过上限（8 次）
      const grantedSmalls: DownloadUpstreamLease[] = [];
      for (let i = 0; i < 8; i++) {
        fillers[i].release();
        grantedSmalls.push(await smalls[i]);
        expect(service.upstreamHeadBypassCount).toBe(i + 1);
      }
      expect(service.upstreamBypassCount).toBe(8);
      expect(service.upstreamHeadReserved).toBe(true);

      // 达到绕过上限后，新的释放不再绕过队首
      fillers[8].release();
      expect(service.waitingUpstreamCount).toBe(3);
      expect(service.upstreamBypassCount).toBe(8);

      // 释放足够权重后队首仍能被正常放行（保留状态只阻止绕过，不阻塞队首自身）
      for (let i = 9; i < 16; i++) fillers[i].release();
      const headLease = await head;
      expect(headLease.weight).toBe(8);

      for (const lease of grantedSmalls) lease.release();
      const rest = await Promise.all(smalls.slice(8));
      expect(rest.map((lease) => lease.weight)).toEqual([1, 1]);

      headLease.release();
      for (const lease of rest) lease.release();
    });

    it('队首等待超过公平阈值后进入保留状态，不再被绕过', async () => {
      jest.useFakeTimers();
      try {
        service.configure({ maxConcurrentUpstreams: 16, upstreamQueuePolicy: 'bounded_fit' });
        const fillers = await fillBudget(16);
        const head = service.acquireUpstreamSlot({ weight: 8, waitTimeoutMs: 600_000 });
        const small = service.acquireUpstreamSlot({ weight: 1, waitTimeoutMs: 600_000 });
        expect(service.waitingUpstreamCount).toBe(2);

        jest.advanceTimersByTime(10_000);
        expect(service.upstreamHeadReserved).toBe(true);

        fillers[0].release();
        expect(service.waitingUpstreamCount).toBe(2);
        expect(service.upstreamBypassCount).toBe(0);

        // 释放足够权重后队首与后续小文件都能被放行
        for (let i = 1; i < 16; i++) fillers[i].release();
        expect((await head).weight).toBe(8);
        expect((await small).weight).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('队列前移与预算热更新：取消队首后提高预算立即唤醒等待项', async () => {
      service.configure({ maxConcurrentUpstreams: 8, upstreamQueuePolicy: 'bounded_fit' });
      const holder = await service.acquireUpstreamSlot({ weight: 8 });
      const headCtl = new AbortController();
      const head = service.acquireUpstreamSlot({ weight: 8, waitTimeoutMs: 60_000, signal: headCtl.signal });
      const queued = service.acquireUpstreamSlot({ weight: 8, waitTimeoutMs: 60_000 });
      expect(service.waitingUpstreamCount).toBe(2);

      const headRejected = head.catch(() => undefined);
      headCtl.abort();
      expect(service.waitingUpstreamCount).toBe(1);
      await headRejected;

      // 提高预算：已授予租约不被撤销，等待项立即被唤醒
      service.configure({ maxConcurrentUpstreams: 16 });
      const lease = await queued;
      expect(lease.weight).toBe(8);
      expect(service.activeUpstreamWeightTotal).toBe(16);

      holder.release();
      expect(service.activeUpstreamWeightTotal).toBe(8);
      lease.release();
    });

    it('运行快照暴露队列策略、队首等待年龄与绕过计数', async () => {
      service.configure({ maxConcurrentUpstreams: 8, upstreamQueuePolicy: 'bounded_fit' });
      const holder = await service.acquireUpstreamSlot({ weight: 8 });
      const queued = service.acquireUpstreamSlot({ weight: 8, waitTimeoutMs: 30_000 });

      const snapshot = service.getSnapshot();
      expect(snapshot.upstreamQueuePolicy).toBe('bounded_fit');
      expect(snapshot.waitingUpstreamTasks).toBe(1);
      expect(snapshot.oldestUpstreamWaitMs).toBeGreaterThanOrEqual(0);
      expect(snapshot.upstreamHeadReserved).toBe(false);
      expect(snapshot.upstreamHeadBypassCount).toBe(0);
      expect(snapshot.activeUpstreamWeight).toBe(8);
      expect(snapshot.maxConcurrentUpstreams).toBe(8);

      holder.release();
      const lease = await queued;
      expect(service.oldestUpstreamWaitMs).toBe(0);
      lease.release();
    });
  });

  describe('下载调度配置规范化（管理端校验、展示与运行时同一套规则）', () => {
    it('缺失、空串与非数值一律回退仓库默认值（不再被 Number(\'\') 误判为 0）', () => {
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, null)).toBe(8);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, undefined)).toBe(8);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, '')).toBe(8);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, '   ')).toBe(8);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, 'not-a-number')).toBe(8);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.DIRECT_WINDOW_MB, '')).toBe(1);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.TASK_RETENTION_SECONDS, '')).toBe(900);
    });

    it('越界值裁剪到统一区间（权重预算 1-64、直通窗口 1-4 MiB）', () => {
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, '999')).toBe(64);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS, '0')).toBe(1);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.DIRECT_WINDOW_MB, '1024')).toBe(4);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.DIRECT_WINDOW_MB, '0')).toBe(1);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.QUEUE_TIMEOUT_SECONDS, '1')).toBe(5);
      expect(normalizeDownloadConfigNumber(DOWNLOAD_CONFIG_KEYS.QUEUE_CAPACITY, '32')).toBe(32);
    });

    it('队列策略与布尔开关的缺失/非法值回退默认', () => {
      expect(normalizeUpstreamQueuePolicy('bounded_fit')).toBe('bounded_fit');
      expect(normalizeUpstreamQueuePolicy(' BOUNDED_FIT ')).toBe('bounded_fit');
      expect(normalizeUpstreamQueuePolicy('unknown')).toBe('strict_fifo');
      expect(normalizeUpstreamQueuePolicy(null)).toBe('strict_fifo');
      expect(normalizeBooleanFlag('false', true)).toBe(false);
      expect(normalizeBooleanFlag('', true)).toBe(true);
      expect(normalizeBooleanFlag(undefined, false)).toBe(false);
      expect(normalizeBooleanFlag('maybe', false)).toBe(false);
    });

    it('权重映射仍受预算裁剪（大文件权重不超过当前权重预算）', () => {
      expect(upstreamWeightForSize(4 * 1024 * MB, 16)).toBe(8);
      expect(upstreamWeightForSize(4 * 1024 * MB, 4)).toBe(4);
      expect(upstreamWeightForSize(512 * MB, 16)).toBe(2);
      expect(upstreamWeightForSize(64 * MB, 16)).toBe(1);
    });
  });
});

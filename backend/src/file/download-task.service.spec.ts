import { NotFoundException } from '@nestjs/common';
import { DownloadTaskService } from './download-task.service';

interface ProbeStub {
  admitted: boolean;
  structural: boolean;
  reason?: string;
  queuePosition: number;
  waitingDiskTasks: number;
  activeUpstreams: number;
  freeBytes: number;
  retryAfterMs: number;
}

function makeTaskRepository() {
  return {
    save: jest.fn(async (entity: Record<string, unknown>) => entity),
    update: jest.fn(async () => ({ affected: 2 })),
    delete: jest.fn(async () => ({ affected: 3 })),
  };
}

/** 可断言 release 次数的预约桩（任务必须真实持有并释放磁盘预约） */
function makeReservation() {
  let active = true;
  return {
    id: `res-${Math.random().toString(36).slice(2, 8)}`,
    sessionKey: 'file:stub',
    grantedBytes: 1024,
    remainingBytes: 1024,
    countsTowardCache: true,
    get active() {
      return active;
    },
    consume: jest.fn(),
    release: jest.fn(() => {
      active = false;
    }),
  };
}

function makeService(options: {
  cached?: boolean;
  probe?: Partial<ProbeStub>;
  retentionMs?: number;
  taskRepository?: ReturnType<typeof makeTaskRepository>;
  /** 同步立即授予是否成功（false 模拟需要排队等待） */
  canReserveNow?: boolean;
  /** 异步排队永不返回（模拟长时间等待，便于稳定观察 queued 状态） */
  reservePending?: boolean;
}) {
  const probe: ProbeStub = {
    admitted: true,
    structural: false,
    queuePosition: 1,
    waitingDiskTasks: 0,
    activeUpstreams: 0,
    freeBytes: 10 * 1024 * 1024,
    retryAfterMs: 5000,
    ...options.probe,
  };
  const reservations: ReturnType<typeof makeReservation>[] = [];
  const fileCacheService = {
    getCachedPath: jest.fn((_fileId: string) => (options.cached ? '/tmp/Cache/x' : null)),
    probeDownloadAdmission: jest.fn((_size: number, _opts?: unknown) => ({ ...probe })),
    tryReserveDownloadNow: jest.fn((_fileId: string, _size: number, _opts?: unknown) => {
      if (options.canReserveNow === false) return null;
      const reservation = makeReservation();
      reservations.push(reservation);
      return reservation;
    }),
    reserveDownload: jest.fn(async (_fileId: string, _size: number, _opts?: unknown) => {
      if (options.reservePending) return new Promise<never>(() => {});
      const reservation = makeReservation();
      reservations.push(reservation);
      return reservation;
    }),
    handOffDownloadReservation: jest.fn(),
    purgeExpiredDownloadReservations: jest.fn(),
    get downloadTaskRetentionMs() {
      return options.retentionMs ?? 900_000;
    },
  };
  const service = new DownloadTaskService(
    fileCacheService as never,
    options.taskRepository as never,
  );
  return { service, fileCacheService, probe, reservations };
}

const baseInput = {
  ownerKey: 'user:u1',
  fileId: '44444444-4444-4444-8444-444444444444',
  expectedSize: 1024,
  downloadUrl: '/api/files/44444444-4444-4444-8444-444444444444/download',
  countsTowardCache: true,
};

describe('DownloadTaskService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('缓存命中时直接可下载，不进入排队（票据挂到目标地址）', () => {
    const { service } = makeService({ cached: true });
    const view = service.create(baseInput);

    expect(view.status).toBe('streamable');
    expect(view.downloadUrl).toContain(baseInput.downloadUrl);
    expect(view.ticket).toBeDefined();
    expect(view.downloadUrl).toContain(`taskTicket=${view.ticket}`);
    expect(view.queueReason).toBeUndefined();
    expect(view.queuePosition).toBeUndefined();
  });

  it('资源可用（未命中缓存）时同步持有真实预约并签发一次性票据', () => {
    const { service, reservations } = makeService({ cached: false });
    const view = service.create(baseInput);

    expect(view.status).toBe('streamable');
    expect(view.expectedSize).toBe(1024);
    // 任务真实持有磁盘预约（不再只是只读探测）
    expect(reservations).toHaveLength(1);
    expect(view.ticket).toBeDefined();
    expect(view.ticketExpiresAt).toBeDefined();
    expect(view.downloadUrl).toContain(`taskTicket=${view.ticket}`);
  });

  it('磁盘空间不足时报告排队原因、近似位置与建议重试间隔', () => {
    const { service } = makeService({
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 3, retryAfterMs: 5000 },
    });
    const view = service.create(baseInput);

    expect(view.status).toBe('queued');
    expect(view.queueReason).toBe('disk');
    expect(view.queuePosition).toBe(3);
    expect(view.retryAfterMs).toBe(5000);
    expect(view.message).toContain('前面还有 2 个任务');
    // 排队中也提供下载地址，前端可在放行后直接触发原生下载
    expect(view.downloadUrl).toBe(baseInput.downloadUrl);
  });

  it('上游连接繁忙时给出独立的排队原因文案', () => {
    const { service } = makeService({
      probe: { admitted: false, structural: false, reason: 'upstream', queuePosition: 1 },
    });
    const view = service.create(baseInput);

    expect(view.status).toBe('queued');
    expect(view.queueReason).toBe('upstream');
    expect(view.message).toContain('下载连接繁忙');
  });

  it('服务器负载较高时提示稍后重试', () => {
    const { service } = makeService({
      probe: { admitted: false, structural: false, reason: 'server_load', queuePosition: 1 },
    });
    const view = service.create(baseInput);

    expect(view.queueReason).toBe('server_load');
    expect(view.message).toContain('负载较高');
  });

  it('结构性不可行（完整暂存放不下）立即变为可下载并标记 direct，不拒绝用户', () => {
    const { service } = makeService({
      probe: { admitted: false, structural: true, reason: 'disk' },
    });
    const view = service.create(baseInput);

    // 历史缺陷：此状态停在 queued，前端会一直轮询到任务过期
    expect(view.status).toBe('streamable');
    expect(view.mode).toBe('direct');
    expect(view.message).toContain('直通');
    expect(view.errorCode).toBeUndefined();
    expect(view.downloadUrl).toContain(baseInput.downloadUrl);
    expect(view.queueReason).toBeUndefined();
  });

  it('票据原子消费：单次有效、绑定归属与文件，并把预约交接给正文请求', () => {
    const { service, fileCacheService, reservations } = makeService({ cached: false });
    const created = service.create(baseInput);
    const ticket = created.ticket!;
    const ownerKey = baseInput.ownerKey;
    const fileId = baseInput.fileId;

    expect(service.consumeTicket(ticket, ownerKey, fileId)).toBe(true);
    expect(fileCacheService.handOffDownloadReservation).toHaveBeenCalledTimes(1);
    // 单次有效：重放失败
    expect(service.consumeTicket(ticket, ownerKey, fileId)).toBe(false);
    // 交接后任务不再持有预约（所有权已转移），关闭时也不应重复释放
    expect(service.heldReservationCount).toBe(0);
    expect(reservations[0].release).not.toHaveBeenCalled();
  });

  it('票据绑定归属与文件：跨用户或跨文件消费失败且仍失效', () => {
    const { service, fileCacheService } = makeService({ cached: false });
    const created = service.create(baseInput);
    const ticket = created.ticket!;

    expect(service.consumeTicket(ticket, 'user:other', baseInput.fileId)).toBe(false);
    expect(service.consumeTicket(ticket, baseInput.ownerKey, 'other-file')).toBe(false);
    // 票据已失效，正确调用者也无法再用
    expect(service.consumeTicket(ticket, baseInput.ownerKey, baseInput.fileId)).toBe(false);
    expect(fileCacheService.handOffDownloadReservation).not.toHaveBeenCalled();
  });

  it('取消任务会释放已持有的真实预约并作废票据', () => {
    const { service, reservations } = makeService({ cached: false });
    const created = service.create(baseInput);

    const cancelled = service.cancel(created.taskId, baseInput.ownerKey);
    expect(cancelled.status).toBe('cancelled');
    expect(reservations[0].release).toHaveBeenCalledTimes(1);
    expect(service.heldReservationCount).toBe(0);
    // 取消后票据不可再用
    expect(service.consumeTicket(created.ticket!, baseInput.ownerKey, baseInput.fileId)).toBe(false);
  });

  it('票据超时未使用：释放预约并作废票据（避免 4GiB 预约滞留到任务保留期）', () => {
    const { service, reservations } = makeService({ cached: false });
    const created = service.create(baseInput);
    expect(service.heldReservationCount).toBe(1);

    // 模拟客户端拿到票据后始终不发起正文请求
    const record = (service as unknown as {
      tasks: Map<string, { ticketExpiresAt?: number }>;
    }).tasks.get(created.taskId)!;
    record.ticketExpiresAt = Date.now() - 1;

    const refreshed = service.refresh(created.taskId, baseInput.ownerKey);
    expect(reservations[0].release).toHaveBeenCalledTimes(1);
    expect(service.heldReservationCount).toBe(0);
    expect(refreshed.status).toBe('streamable');
    // 票据已作废：过期后不得再被消费
    expect(service.consumeTicket(created.ticket!, baseInput.ownerKey, baseInput.fileId)).toBe(false);
  });

  it('等待预约的任务在取得资源后变为 streamable 并签发票据', async () => {
    const { service, fileCacheService, probe } = makeService({
      cached: false,
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 2 },
    });
    // 首轮探测判定排队 → 走异步真实排队；随后模拟资源释放
    const created = service.create(baseInput);
    expect(created.status).toBe('queued');
    expect(fileCacheService.reserveDownload).toHaveBeenCalledTimes(1);

    probe.admitted = true;
    // 异步排队是 fire-and-forget：等待其完成后再查询
    await new Promise(resolve => setImmediate(resolve));
    const refreshed = service.refresh(created.taskId, baseInput.ownerKey);
    expect(refreshed.status).toBe('streamable');
    expect(refreshed.ticket).toBeDefined();
  });

  it('查询会重新评估状态（排队 → 可下载）', () => {
    const { service, probe } = makeService({
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 2 },
    });
    const created = service.create(baseInput);
    expect(created.status).toBe('queued');

    probe.admitted = true;
    const refreshed = service.refresh(created.taskId, baseInput.ownerKey);
    expect(refreshed.status).toBe('streamable');
    expect(refreshed.queueReason).toBeUndefined();
  });

  it('取消排队任务后状态为 cancelled 且幂等', () => {
    const { service } = makeService({
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 2 },
      reservePending: true,
    });
    const created = service.create(baseInput);

    const cancelled = service.cancel(created.taskId, baseInput.ownerKey);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.message).toContain('已取消');
    // 取消后不再被后续评估改写
    const again = service.refresh(created.taskId, baseInput.ownerKey);
    expect(again.status).toBe('cancelled');
    expect(service.cancel(created.taskId, baseInput.ownerKey).status).toBe('cancelled');
  });

  it('跨用户访问任务按不存在处理（不可探测他人任务）', () => {
    const { service } = makeService({ cached: true });
    const created = service.create(baseInput);

    expect(() => service.refresh(created.taskId, 'user:other')).toThrow(NotFoundException);
    expect(() => service.cancel(created.taskId, 'user:other')).toThrow(NotFoundException);
  });

  it('任务过期后返回 expired 与结构化错误码', () => {
    const { service } = makeService({ cached: true });
    const created = service.create(baseInput);

    // 直接推进到期时间模拟保留期结束
    const record = (service as unknown as { tasks: Map<string, { expiresAt: number }> }).tasks.get(created.taskId)!;
    record.expiresAt = Date.now() - 1;

    const view = service.refresh(created.taskId, baseInput.ownerKey);
    expect(view.status).toBe('expired');
    expect(view.errorCode).toBe('DOWNLOAD_TASK_EXPIRED');
    expect(view.downloadUrl).toBeUndefined();
  });

  it('轮询只读：refresh 不重复申请资源（不影响真实调度）', () => {
    const { service, fileCacheService } = makeService({
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 1 },
      reservePending: true,
    });
    const created = service.create(baseInput);
    service.refresh(created.taskId, baseInput.ownerKey);
    service.refresh(created.taskId, baseInput.ownerKey);

    // 每次评估最多一次只读探测；真实排队只在创建时发起一次
    expect(fileCacheService.probeDownloadAdmission).toHaveBeenCalledTimes(3);
    expect(fileCacheService.reserveDownload).toHaveBeenCalledTimes(1);
    expect(service.activeTaskCount).toBe(1);
  });

  it('持久化：状态变化才写库，轮询不产生写放大', async () => {
    const taskRepository = makeTaskRepository();
    const { service } = makeService({
      taskRepository,
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 2 },
      reservePending: true,
    });
    const created = service.create(baseInput);
    // 创建：写一次
    expect(taskRepository.save).toHaveBeenCalledTimes(1);
    expect(taskRepository.save.mock.calls[0][0]).toMatchObject({
      id: created.taskId,
      status: 'queued',
      queueReason: 'disk',
    });

    // 状态未变：轮询不再写库
    service.refresh(created.taskId, baseInput.ownerKey);
    service.refresh(created.taskId, baseInput.ownerKey);
    expect(taskRepository.save).toHaveBeenCalledTimes(1);

    // 取消：状态变化，写第二次
    service.cancel(created.taskId, baseInput.ownerKey);
    expect(taskRepository.save).toHaveBeenCalledTimes(2);
    expect(taskRepository.save.mock.calls[1][0]).toMatchObject({ status: 'cancelled' });
  });

  it('持久化失败不影响下载任务本身（fail-soft）', async () => {
    const taskRepository = makeTaskRepository();
    taskRepository.save.mockRejectedValue(new Error('db down'));
    const { service } = makeService({ cached: true, taskRepository });

    const view = service.create(baseInput);
    expect(view.status).toBe('streamable');
    // 等待 fire-and-forget 写库失败被吞掉，不产生未处理拒绝
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('重启恢复：把遗留的排队任务标记为过期，并清理过期记录', async () => {
    const taskRepository = makeTaskRepository();
    const { service } = makeService({ taskRepository });

    await service.onModuleInit();
    expect(taskRepository.update).toHaveBeenCalledWith(
      { status: 'queued' },
      { status: 'expired', errorCode: 'DOWNLOAD_TASK_EXPIRED' },
    );

    await service.cleanupExpiredTaskRecords();
    expect(taskRepository.delete).toHaveBeenCalledTimes(1);
  });

  it('未注入仓储时（单测/降级）持久化与清理均为空操作', async () => {
    const { service } = makeService({ cached: true });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.cleanupExpiredTaskRecords()).resolves.toBeUndefined();
    expect(service.create(baseInput).status).toBe('streamable');
  });

  it('关闭时取消排队任务并清空记录', async () => {
    const { service } = makeService({
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 1 },
      reservePending: true,
    });
    const created = service.create(baseInput);
    await service.onApplicationShutdown();

    expect(service.activeTaskCount).toBe(0);
    expect(() => service.refresh(created.taskId, baseInput.ownerKey)).toThrow(NotFoundException);
  });
});

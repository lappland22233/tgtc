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

function makeService(options: {
  cached?: boolean;
  probe?: Partial<ProbeStub>;
  retentionMs?: number;
  taskRepository?: ReturnType<typeof makeTaskRepository>;
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
  const fileCacheService = {
    getCachedPath: jest.fn((_fileId: string) => (options.cached ? '/tmp/Cache/x' : null)),
    probeDownloadAdmission: jest.fn((_size: number, _opts?: unknown) => ({ ...probe })),
    get downloadTaskRetentionMs() {
      return options.retentionMs ?? 900_000;
    },
  };
  const service = new DownloadTaskService(
    fileCacheService as never,
    options.taskRepository as never,
  );
  return { service, fileCacheService, probe };
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

  it('缓存命中时直接可下载，不进入排队', () => {
    const { service } = makeService({ cached: true });
    const view = service.create(baseInput);

    expect(view.status).toBe('streamable');
    expect(view.downloadUrl).toBe(baseInput.downloadUrl);
    expect(view.queueReason).toBeUndefined();
    expect(view.queuePosition).toBeUndefined();
  });

  it('资源可用（未命中缓存）时同样立即给出可下载与目标地址', () => {
    const { service } = makeService({ cached: false });
    const view = service.create(baseInput);

    expect(view.status).toBe('streamable');
    expect(view.downloadUrl).toBe(baseInput.downloadUrl);
    expect(view.expectedSize).toBe(1024);
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

  it('结构性不可行（完整暂存放不下）仍视为可下载（走直通），不拒绝用户', () => {
    const { service } = makeService({
      probe: { admitted: false, structural: true, reason: 'disk' },
    });
    const view = service.create(baseInput);

    expect(view.status).toBe('queued');
    expect(view.message).toContain('直通');
    expect(view.errorCode).toBeUndefined();
    expect(view.downloadUrl).toBe(baseInput.downloadUrl);
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

  it('状态探测只读：不占用预约、不排队（轮询不影响真实调度）', () => {
    const { service, fileCacheService } = makeService({
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 1 },
    });
    const created = service.create(baseInput);
    service.refresh(created.taskId, baseInput.ownerKey);
    service.refresh(created.taskId, baseInput.ownerKey);

    // 每次评估最多一次探测调用，且仅调用只读探测接口
    expect(fileCacheService.probeDownloadAdmission).toHaveBeenCalledTimes(3);
    expect(service.activeTaskCount).toBe(1);
  });

  it('持久化：状态变化才写库，轮询不产生写放大', async () => {
    const taskRepository = makeTaskRepository();
    const { service } = makeService({
      taskRepository,
      probe: { admitted: false, structural: false, reason: 'disk', queuePosition: 2 },
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
    });
    const created = service.create(baseInput);
    await service.onApplicationShutdown();

    expect(service.activeTaskCount).toBe(0);
    expect(() => service.refresh(created.taskId, baseInput.ownerKey)).toThrow(NotFoundException);
  });
});

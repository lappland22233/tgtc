import 'reflect-metadata';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { OpsObservationService } from './ops-observation.service';
import { freeDiskBytes } from '../file/cache-disk-manager';

jest.mock('../file/cache-disk-manager', () => ({ freeDiskBytes: jest.fn() }));

const GIB = 1024 * 1024 * 1024;

function makeQueue(counts: Record<string, number> | Error) {
  return {
    getJobCounts: jest.fn().mockImplementation(async () => {
      if (counts instanceof Error) throw counts;
      return counts;
    }),
  } as any;
}

describe('OpsObservationService（C-16 运维基础设施 dead-man switch）', () => {
  let cwd: string;
  let createAlerts: jest.Mock;
  let upload: any;
  let verify: any;
  let metrics: any;
  let service: OpsObservationService;
  const mockedFree = freeDiskBytes as jest.Mock;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ops-obs-'));
    mkdirSync(path.join(cwd, 'tmp', 'Cache'), { recursive: true });
    mkdirSync(path.join(cwd, 'tmp', 'uploads', 'pending'), { recursive: true });
    jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    mockedFree.mockReturnValue(10 * GIB);
    createAlerts = jest.fn().mockResolvedValue(undefined);
    upload = makeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    verify = makeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    metrics = makeQueue({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    service = new OpsObservationService({ createAlerts } as any, upload, verify, metrics);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  const ruleIds = () => createAlerts.mock.calls.flatMap((call) => call[0].map((a: any) => a.ruleId));

  it('磁盘与队列均正常时不产生告警', async () => {
    await service.observe();
    expect(createAlerts).not.toHaveBeenCalled();
  });

  it('磁盘余量低于阈值触发 OPS_DISK_LOW（critical）', async () => {
    mockedFree.mockReturnValue(1 * GIB);
    await service.observe();
    expect(ruleIds()).toContain('OPS_DISK_LOW');
    const alert = createAlerts.mock.calls[0][0][0];
    expect(alert.level).toBe('critical');
    expect(alert.context.thresholdBytes).toBe(2 * GIB);
  });

  it('statfs 探测失败也告警：无法确认余量时按空间不足处理', async () => {
    mockedFree.mockReturnValue(null);
    await service.observe();
    expect(ruleIds()).toContain('OPS_DISK_LOW');
    expect(createAlerts.mock.calls[0][0][0].context.unprobeable.length).toBeGreaterThan(0);
  });

  it('目录尚未创建（全新部署）时不误报磁盘告警', async () => {
    rmSync(path.join(cwd, 'tmp'), { recursive: true, force: true });
    await service.observe();
    expect(ruleIds()).not.toContain('OPS_DISK_LOW');
  });

  it('队列查询失败（Redis 不可用）触发 OPS_SCHEDULER_STALLED，且不再评估积压', async () => {
    upload = makeQueue(new Error('ECONNREFUSED'));
    service = new OpsObservationService({ createAlerts } as any, upload, verify, metrics);
    await service.observe();
    expect(ruleIds()).toEqual(['OPS_SCHEDULER_STALLED']);
    expect(createAlerts.mock.calls[0][0][0].level).toBe('critical');
  });

  it('上传队列等待超阈值触发 OPS_UPLOAD_QUEUE_BACKLOG', async () => {
    upload = makeQueue({ waiting: 250, active: 2, delayed: 10, failed: 0 });
    service = new OpsObservationService({ createAlerts } as any, upload, verify, metrics);
    await service.observe();
    expect(ruleIds()).toContain('OPS_UPLOAD_QUEUE_BACKLOG');
  });

  it('上传队列失败数超阈值同样触发积压告警', async () => {
    verify = makeQueue({ waiting: 0, active: 0, delayed: 0, failed: 80 });
    service = new OpsObservationService({ createAlerts } as any, upload, verify, metrics);
    await service.observe();
    expect(ruleIds()).toContain('OPS_UPLOAD_QUEUE_BACKLOG');
  });

  it('指标聚合队列堆积触发 OPS_SCHEDULER_STALLED（消费者不前进）', async () => {
    metrics = makeQueue({ waiting: 25, active: 0, delayed: 0, failed: 0 });
    service = new OpsObservationService({ createAlerts } as any, upload, verify, metrics);
    await service.observe();
    expect(ruleIds()).toContain('OPS_SCHEDULER_STALLED');
  });

  it('告警引擎写库失败不得中断观测循环', async () => {
    mockedFree.mockReturnValue(0);
    createAlerts.mockRejectedValue(new Error('db down'));
    await expect(service.observe()).resolves.toBeUndefined();
  });
});
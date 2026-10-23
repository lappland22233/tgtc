import { HttpException } from '@nestjs/common';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { UploadDiskBudgetService } from './upload-disk-budget.service';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('UploadDiskBudgetService', () => {
  let cwd: string;
  let repository: { findOne: jest.Mock };
  let cache: { isNoCacheMode: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'upload-disk-budget-'));
    jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    repository = { findOne: jest.fn().mockResolvedValue(null) };
    cache = { isNoCacheMode: jest.fn().mockReturnValue(true) };
    config = { get: jest.fn().mockReturnValue(undefined) };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  function createService() {
    return new UploadDiskBudgetService(repository as any, cache as any, config as any);
  }

  it('defaults to strict mode for a single no-cache backend and serializes active leases', async () => {
    const service = createService();

    await service.acquireSession('session-a', 1024);
    expect(service.hasActiveLease()).toBe(true);
    await expect(service.acquireSession('session-b', 1024)).rejects.toMatchObject({ status: 429 });

    expect(service.transferSessionToJob('session-a', UUID, 1)).toBe(true);
    // 配置热切换不会让已经取得的严格租约泄漏。
    cache.isNoCacheMode.mockReturnValue(false);
    service.transferJobToSession('session-a', UUID, 1);
    service.releaseSession('session-a');
    expect(service.hasActiveLease()).toBe(false);
  });

  it('returns a queue-oriented 429 body that distinguishes queuing from disk exhaustion', async () => {
    const service = createService();
    await service.acquireSession('session-a', 1024);

    let caught: unknown;
    try {
      await service.acquireSession('session-b', 1024);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);
    const exception = caught as HttpException;
    expect(exception.getStatus()).toBe(429);
    const response = exception.getResponse() as {
      code?: unknown;
      errorCode?: unknown;
      retryAfterMs?: unknown;
      message?: unknown;
    };
    // 前端错误映射读取 errorCode：排队必须与「存储空间不足」区分开，不能被归入磁盘告警。
    expect(response.errorCode).toBe('UPLOAD_DISK_BUDGET_BUSY');
    expect(response.code).toBe('UPLOAD_DISK_BUDGET_BUSY');
    expect(response.retryAfterMs).toBe(5000);
    expect(String(response.message)).not.toContain('磁盘');
  });

  it('removes terminal UUID artifacts but blocks unknown pending sources', async () => {
    const pendingDir = path.join(cwd, 'tmp', 'uploads', 'pending');
    await mkdir(pendingDir, { recursive: true });
    await writeFile(path.join(pendingDir, UUID), 'terminal');
    await writeFile(path.join(pendingDir, `${UUID}.telegram.json`), '{}');
    repository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: UUID, status: 'error', uploadStage: 'failed' });

    const service = createService();
    await service.acquireSession('session-a', 1024);
    await expect(stat(path.join(pendingDir, UUID))).rejects.toMatchObject({ code: 'ENOENT' });
    service.releaseSession('session-a');

    await writeFile(path.join(pendingDir, 'unexpected-upload-source'), 'unknown');
    await expect(service.acquireSession('session-b', 1024)).rejects.toBeInstanceOf(HttpException);
  });

  it('can be explicitly disabled for a multi-process deployment', async () => {
    config.get.mockReturnValue('false');
    const service = createService();

    expect(service.isStrictMode()).toBe(false);
    await service.acquireSession('session-a', 1024);
    await service.acquireSession('session-b', 1024);
    expect(service.hasActiveLease()).toBe(false);
  });

  it('exposes the lease holder for diagnostics', async () => {
    const service = createService();
    expect(service.describeActiveLease()).toBeNull();

    await service.acquireSession('session-a', 2048);
    const lease = service.describeActiveLease();

    expect(lease?.key).toBe('session:session-a');
    expect(lease?.fileSize).toBe(2048);
    expect(lease?.heldMs).toBeGreaterThanOrEqual(0);
  });

  it('reports whether a release actually matched the held lease', async () => {
    const service = createService();
    await service.acquireSession('session-a', 1024);

    // key 不匹配（例如 done 会话的租约已转交 Worker job）时绝不误释放
    expect(service.releaseSession('session-b')).toBe(false);
    expect(service.hasActiveLease()).toBe(true);
    expect(service.releaseSession('session-a')).toBe(true);
    expect(service.releaseSession('session-a')).toBe(false);
  });

  it('warns once per minute when a stale lease keeps rejecting new sessions', async () => {
    const service = createService();
    const warn = jest.spyOn((service as any).logger, 'warn');
    await service.acquireSession('session-a', 1024);

    // 正常排队是秒级，持有不足 60s 不告警
    await expect(service.acquireSession('session-b', 1024)).rejects.toMatchObject({ status: 429 });
    expect(warn).not.toHaveBeenCalled();

    // 僵尸租约：持有超过 60s 才告警，且同一 key 每 60s 最多一条，避免 5s 轮询刷屏
    (service as any).activeLease.acquiredAt = Date.now() - 120_000;
    await expect(service.acquireSession('session-b', 1024)).rejects.toMatchObject({ status: 429 });
    await expect(service.acquireSession('session-c', 1024)).rejects.toMatchObject({ status: 429 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('session:session-a');
    warn.mockRestore();
  });

  it('keeps the 429 contract unchanged when logging a blocking lease', async () => {
    const service = createService();
    await service.acquireSession('session-a', 1024);
    (service as any).activeLease.acquiredAt = Date.now() - 120_000;

    let caught: unknown;
    try {
      await service.acquireSession('session-b', 1024);
    } catch (error) {
      caught = error;
    }

    const response = (caught as HttpException).getResponse() as Record<string, unknown>;
    expect(response.code).toBe('UPLOAD_DISK_BUDGET_BUSY');
    expect(response.errorCode).toBe('UPLOAD_DISK_BUDGET_BUSY');
    expect(response.retryAfterMs).toBe(5000);
    expect(String(response.message)).toBe('服务器正在依次处理另一份大文件，本文件已自动排队，请保持页面打开');
  });
});

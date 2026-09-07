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
});

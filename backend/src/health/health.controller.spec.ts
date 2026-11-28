import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController, readReleaseVersion } from './health.controller';
import { VersionService } from '../version/version.service';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('HealthController', () => {
  const dataSource = { query: jest.fn() } as any;
  const versionService = { getCurrentVersion: jest.fn(() => 'unknown') } as unknown as VersionService;
  const queue = { client: { ping: jest.fn() } } as any;
  const controller = new HealthController(dataSource, versionService, queue);

  afterEach(() => jest.resetAllMocks());

  it('reports healthy only after the database probe succeeds', async () => {
    dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    queue.client.ping.mockResolvedValueOnce('PONG');
    await expect(controller.health()).resolves.toEqual({ status: 'ok', database: 'ok', redis: 'ok' });
    expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('C-14 回归：Redis 不可用时探针必须非绿（Bull 任务已静默停摆）', async () => {
    dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    queue.client.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(controller.health()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('C-14 回归：Redis 探活挂起时按超时判失败，不得无限等待', async () => {
    jest.useFakeTimers();
    try {
      dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      queue.client.ping.mockReturnValueOnce(new Promise(() => {}));
      const pending = controller.health();
      const assertion = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.advanceTimersByTimeAsync(3000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('DB 不可用时不再探 Redis，直接判不可服务', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('db down'));
    await expect(controller.health()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(queue.client.ping).not.toHaveBeenCalled();
  });

  it('does not expose database errors through the health endpoint', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('postgres://secret@example.invalid/db'));
    await expect(controller.health()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('exposes the version from the unified VersionService', () => {
    (versionService.getCurrentVersion as jest.Mock).mockReturnValueOnce('1.2.3');
    expect(controller.version()).toEqual({ version: '1.2.3' });
  });

  it('reads only a valid release version and safely degrades otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgtc-health-'));
    const valid = join(dir, 'VERSION');
    const invalid = join(dir, 'invalid');
    writeFileSync(valid, '1.2.3\n');
    writeFileSync(invalid, '../secret\n');
    expect(readReleaseVersion(valid)).toBe('1.2.3');
    expect(readReleaseVersion(invalid)).toBe('unknown');
    expect(readReleaseVersion(join(dir, 'missing'))).toBe('unknown');
    rmSync(dir, { recursive: true, force: true });
  });
});

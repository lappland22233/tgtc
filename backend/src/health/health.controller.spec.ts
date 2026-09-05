import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController, readReleaseVersion } from './health.controller';
import { VersionService } from '../version/version.service';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('HealthController', () => {
  const dataSource = { query: jest.fn() } as any;
  const versionService = { getCurrentVersion: jest.fn(() => 'unknown') } as unknown as VersionService;
  const controller = new HealthController(dataSource, versionService);

  afterEach(() => jest.resetAllMocks());

  it('reports healthy only after the database probe succeeds', async () => {
    dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(controller.health()).resolves.toEqual({ status: 'ok', database: 'ok' });
    expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
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

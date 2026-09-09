import { createHash, generateKeyPairSync, constants, sign as cryptoSign } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GithubReleaseClient, GithubReleaseRaw } from './github-release.client';
import {
  UpdateCheckService,
  UpdateCandidate,
} from './update-check.service';
import { loadUpdateConfig, UpdateConfig } from './update.config';
import { VersionService } from '../version/version.service';

/**
 * 测试辅助：在进程内生成 RSA 密钥对并构造一套可通过完整可信核验的
 * 清单 / SHA256SUMS / 签名制品，公钥写入临时文件供服务加载。
 */
function buildFixture(version: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const assetName = `tgtc-v${version}-linux-x64.zip`;
  const zipSha256 = createHash('sha256').update(`zip-bytes-${version}`).digest('hex');
  const manifest = {
    schemaVersion: 1,
    version,
    channel: 'stable' as const,
    publishedAt: '2026-09-01T00:00:00Z',
    platform: 'linux' as const,
    arch: 'x64' as const,
    asset: { name: assetName, size: 1234, sha256: zipSha256 },
    minUpgradableVersion: '0.0.0',
    maxUpgradableVersion: null,
    includesDbMigration: false,
    programRollbackSafe: true,
    healthCheck: { path: '/api/health', timeoutMs: 30000 },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const sumsBytes = Buffer.from(`${zipSha256}  ${assetName}\n${manifestSha256}  release-manifest.json\n`);
  const sigBytes = cryptoSign('sha256', sumsBytes, {
    key: privateKeyPem,
    padding: constants.RSA_PKCS1_PADDING,
  });

  const asset = (name: string, size: number) => ({
    id: 1,
    name,
    size,
    browser_download_url: `https://github.com/lappland22233/tgtc/releases/download/v${version}/${name}`,
  });
  const release: GithubReleaseRaw = {
    id: 42,
    tag_name: `v${version}`,
    name: `TGTC v${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-09-01T00:00:00Z',
    body: 'release notes\nline2',
    html_url: `https://github.com/lappland22233/tgtc/releases/tag/v${version}`,
    assets: [
      asset(assetName, 1234),
      asset('release-manifest.json', manifestBytes.length),
      asset('SHA256SUMS', sumsBytes.length),
      asset('SHA256SUMS.sig', sigBytes.length),
    ],
  };

  const bytesByUrl = (url: string): Buffer => {
    if (url.endsWith('release-manifest.json')) return manifestBytes;
    if (url.endsWith('SHA256SUMS.sig')) return sigBytes;
    if (url.endsWith('SHA256SUMS')) return sumsBytes;
    throw new Error(`unexpected url: ${url}`);
  };

  return { version, assetName, manifest, release, bytesByUrl, publicKeyPem };
}

/** 内存版 ConfigCacheService 桩：跨服务实例共享数据以模拟重启恢复。 */
class FakeConfigCache {
  readonly store = new Map<string, string>();
  readonly setCalls: Array<{ key: string; value: string }> = [];

  async get(key: string, defaultValue: string): Promise<string> {
    return this.store.get(key) ?? defaultValue;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    this.setCalls.push({ key, value });
  }
}

describe('UpdateCheckService', () => {
  const version = '1.0.0';
  const fixture = buildFixture('1.1.0');
  let publicKeyDir: string;

  beforeAll(() => {
    publicKeyDir = mkdtempSync(join(tmpdir(), 'tgtc-update-key-'));
    writeFileSync(join(publicKeyDir, 'update-public-key.pem'), fixture.publicKeyPem);
  });

  afterAll(() => {
    rmSync(publicKeyDir, { recursive: true, force: true });
  });

  interface Harness {
    configCache: FakeConfigCache;
    fetchReleases: jest.Mock;
    fetchAssetBytes: jest.Mock;
    fetchReleaseById: jest.Mock;
    getCurrentVersion: jest.Mock;
    buildService(): UpdateCheckService;
  }

  function createHarness(options: { currentVersion?: string } = {}): Harness {
    const configCache = new FakeConfigCache();
    const fetchReleases = jest.fn();
    const fetchAssetBytes = jest.fn((url: string) => Promise.resolve(fixture.bytesByUrl(url)));
    const fetchReleaseById = jest.fn();
    const getCurrentVersion = jest.fn(() => options.currentVersion ?? version);
    const config: UpdateConfig = {
      ...loadUpdateConfig({}),
      publicKeyPath: join(publicKeyDir, 'update-public-key.pem'),
    };
    return {
      configCache,
      fetchReleases,
      fetchAssetBytes,
      fetchReleaseById,
      getCurrentVersion,
      buildService() {
        return new UpdateCheckService(
          { getCurrentVersion } as unknown as VersionService,
          { fetchReleases, fetchAssetBytes, fetchReleaseById } as unknown as GithubReleaseClient,
          config,
          configCache as never,
        );
      },
    };
  }

  it('已是最新版：不下载资产，返回 up_to_date', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [{ ...fixture.release, tag_name: `v${version}` }], etag: 'e1' });

    const result = await h.buildService().check();

    expect(result.status).toBe('up_to_date');
    expect(result.stale).toBe(false);
    expect(result.candidate).toBeNull();
    expect(result.latestStableVersion).toBe(version);
    expect(h.fetchAssetBytes).not.toHaveBeenCalled();
    expect(h.configCache.setCalls).toHaveLength(1);
  });

  it('有更高稳定版：完成清单/签名核验并返回候选，快照落库', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [fixture.release], etag: 'e2' });

    const result = await h.buildService().check();

    expect(result.status).toBe('update_available');
    expect(result.candidate).toMatchObject({
      releaseId: 42,
      releaseTag: 'v1.1.0',
      version: '1.1.0',
      compatible: true,
      compatibilityReason: null,
    });
    expect(result.candidate?.manifest.version).toBe('1.1.0');
    expect(result.candidate?.asset.sha256).toBe(fixture.manifest.asset.sha256);
    expect(result.lastSuccessfulCheckAt).toBe(result.checkedAt);
    expect(h.configCache.store.get('update_check_snapshot')).toContain('"version":"1.1.0"');
  });

  it('忽略 draft、prerelease 和预发布 SemVer', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValue({
      status: 200,
      releases: [
        { ...fixture.release, draft: true, tag_name: 'v9.0.0' },
        { ...fixture.release, prerelease: true, tag_name: 'v2.0.0-beta.1' },
        { ...fixture.release, tag_name: 'v2.0.0-rc.1' },
      ],
      etag: null,
    });

    const result = await h.buildService().check();

    expect(result.status).toBe('up_to_date');
    expect(result.latestStableVersion).toBeNull();
  });

  it('非法 tag 被忽略，不参与候选比较', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValue({
      status: 200,
      releases: [
        { ...fixture.release, tag_name: 'release-9' },
        { ...fixture.release, tag_name: 'vX.Y.Z' },
      ],
      etag: null,
    });

    const result = await h.buildService().check();

    expect(result.status).toBe('up_to_date');
    expect(result.latestStableVersion).toBeNull();
  });

  it('候选低于当前版本时按防降级处理为已是最新', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValue({
      status: 200,
      releases: [{ ...fixture.release, tag_name: 'v0.9.0' }],
      etag: null,
    });

    const result = await h.buildService().check();

    expect(result.status).toBe('up_to_date');
    expect(result.latestStableVersion).toBe('0.9.0');
    expect(result.candidate).toBeNull();
  });

  it('候选资产缺失时返回核验失败且不落成功快照', async () => {
    const h = createHarness();
    const broken = { ...fixture.release, assets: fixture.release.assets.filter((a) => a.name !== 'SHA256SUMS.sig') };
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [broken], etag: 'e3' });

    const result = await h.buildService().check();

    expect(result.status).toBe('error');
    expect(result.reason).toBe('release_incomplete');
    expect(result.candidate).toBeNull();
    expect(result.lastSuccessfulCheckAt).toBeNull();
    expect(h.configCache.setCalls).toHaveLength(0);
  });

  it('签名被篡改时核验失败', async () => {
    const h = createHarness();
    h.fetchAssetBytes.mockImplementation((url: string) => {
      const bytes = fixture.bytesByUrl(url);
      if (url.endsWith('SHA256SUMS.sig')) {
        const tampered = Buffer.from(bytes);
        tampered[0] ^= 0xff;
        return Promise.resolve(tampered);
      }
      return Promise.resolve(bytes);
    });
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [fixture.release], etag: 'e4' });

    const result = await h.buildService().check();

    expect(result.status).toBe('error');
    expect(result.reason).toBe('release_mismatch');
    expect(result.candidate).toBeNull();
  });

  it('清单摘要与 SHA256SUMS 不一致时核验失败', async () => {
    const h = createHarness();
    h.fetchAssetBytes.mockImplementation((url: string) => {
      if (url.endsWith('release-manifest.json')) {
        const tampered = JSON.parse(fixture.bytesByUrl(url).toString('utf8'));
        tampered.asset.sha256 = '0'.repeat(64);
        return Promise.resolve(Buffer.from(JSON.stringify(tampered)));
      }
      return Promise.resolve(fixture.bytesByUrl(url));
    });
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [fixture.release], etag: 'e5' });

    const result = await h.buildService().check();

    expect(result.status).toBe('error');
    expect(result.reason).toBe('release_mismatch');
  });

  it('兼容窗口之下：候选保留但标记不可自动升级', async () => {
    const h = createHarness();
    h.fetchAssetBytes.mockImplementation((url: string) => {
      if (url.endsWith('release-manifest.json')) {
        // 高于当前版本(1.0.0)但低于清单版本(1.1.0)的合法下限。
        const adjusted = JSON.parse(fixture.bytesByUrl(url).toString('utf8'));
        adjusted.minUpgradableVersion = '1.0.1';
        return Promise.resolve(Buffer.from(JSON.stringify(adjusted)));
      }
      return Promise.resolve(fixture.bytesByUrl(url));
    });
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [fixture.release], etag: 'e6' });

    const result = await h.buildService().check();

    expect(result.status).toBe('update_available');
    expect(result.candidate?.compatible).toBe(false);
    expect(result.candidate?.compatibilityReason).toBe('below_min_upgradable');
  });

  it('programRollbackSafe=false 时标记不可自动升级', async () => {
    const h = createHarness();
    h.fetchAssetBytes.mockImplementation((url: string) => {
      if (url.endsWith('release-manifest.json')) {
        const adjusted = JSON.parse(fixture.bytesByUrl(url).toString('utf8'));
        adjusted.programRollbackSafe = false;
        return Promise.resolve(Buffer.from(JSON.stringify(adjusted)));
      }
      return Promise.resolve(fixture.bytesByUrl(url));
    });
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [fixture.release], etag: 'e7' });

    const result = await h.buildService().check();

    expect(result.candidate?.compatible).toBe(false);
    expect(result.candidate?.compatibilityReason).toBe('rollback_unsafe');
  });

  it.each([
    ['超时', { code: 'ETIMEDOUT' }, 'timeout'],
    ['限流', { response: { status: 429 } }, 'rate_limited'],
    ['拒绝访问', { response: { status: 403 } }, 'rate_limited'],
    ['不可达', { code: 'ENOTFOUND' }, 'network'],
    ['服务端错误', { code: 'ERR_BAD_RESPONSE' }, 'http_5xx'],
  ])('GitHub %s 故障：无快照时返回 error，不伪装成最新', async (_label, error, reason) => {
    const h = createHarness();
    h.fetchReleases.mockRejectedValue(error);

    const result = await h.buildService().check();

    expect(result.status).toBe('error');
    expect(result.reason).toBe(reason);
    expect(result.candidate).toBeNull();
    expect(result.lastSuccessfulCheckAt).toBeNull();
  });

  it('GitHub 故障但有最后成功快照：返回 stale 且保留候选', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValueOnce({ status: 200, releases: [fixture.release], etag: 'e8' });
    const service = h.buildService();
    await service.check();

    h.fetchReleases.mockRejectedValueOnce({ response: { status: 429 } });
    const stale = await service.check();

    expect(stale.status).toBe('stale');
    expect(stale.stale).toBe(true);
    expect(stale.reason).toBe('rate_limited');
    expect(stale.candidate?.version).toBe('1.1.0');
    expect(stale.lastSuccessfulCheckAt).not.toBeNull();
    expect(stale.checkedAt >= stale.lastSuccessfulCheckAt!).toBe(true);
  });

  it('重启恢复：新实例从 DB 快照读取 last-success，故障时降级为 stale', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValueOnce({ status: 200, releases: [fixture.release], etag: 'e9' });
    await h.buildService().check();

    const rebooted = h.buildService();
    h.fetchReleases.mockRejectedValueOnce({ response: { status: 503 } });
    const result = await rebooted.check();

    expect(result.status).toBe('stale');
    expect(result.candidate?.version).toBe('1.1.0');
    expect(result.lastSuccessfulCheckAt).not.toBeNull();
  });

  it('304：快照续期，结论按当前版本复算且不标记 stale', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValueOnce({ status: 200, releases: [fixture.release], etag: 'e10' });
    await h.buildService().check();

    h.fetchReleases.mockResolvedValueOnce({ status: 304, releases: undefined, headers: {} });
    const result = await h.buildService().check();

    expect(result.status).toBe('update_available');
    expect(result.stale).toBe(false);
    expect(result.candidate?.version).toBe('1.1.0');
    expect(h.fetchReleases).toHaveBeenLastCalledWith('e10');
  });

  it('单飞：并发检查共享同一次外呼', async () => {
    const h = createHarness();
    let resolveFetch: (value: unknown) => void = () => undefined;
    h.fetchReleases.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    const service = h.buildService();
    const combined = Promise.all([service.check(), service.check()]);
    resolveFetch({ status: 200, releases: [fixture.release], etag: null });
    const [a, b] = await combined;

    expect(a.status).toBe('update_available');
    expect(b).toBe(a);
    expect(h.fetchReleases).toHaveBeenCalledTimes(1);
  });

  it('非强制检查受最小外呼间隔约束', async () => {
    const h = createHarness();
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [], etag: null });
    const service = h.buildService();

    await service.check();
    await service.check(false);

    expect(h.fetchReleases).toHaveBeenCalledTimes(1);
  });

  it('更新检查开关关闭时返回 disabled 且不外呼', async () => {
    const h = createHarness();
    const config: UpdateConfig = {
      ...loadUpdateConfig({ UPDATE_CHECK_ENABLED: 'false' }),
      publicKeyPath: join(publicKeyDir, 'update-public-key.pem'),
    };
    const service = new UpdateCheckService(
      { getCurrentVersion: h.getCurrentVersion } as unknown as VersionService,
      { fetchReleases: h.fetchReleases } as unknown as GithubReleaseClient,
      config,
      h.configCache as never,
    );

    const result = await service.check();

    expect(result.status).toBe('disabled');
    expect(h.fetchReleases).not.toHaveBeenCalled();
  });

  it('当前版本未知时返回明确错误而非盲目比较', async () => {
    const h = createHarness({ currentVersion: 'unknown' });
    h.fetchReleases.mockResolvedValue({ status: 200, releases: [fixture.release], etag: null });

    const result = await h.buildService().check();

    expect(result.status).toBe('error');
    expect(result.reason).toBe('current_version_unknown');
    expect(h.fetchReleases).not.toHaveBeenCalled();
  });

  it('getVerifiedCandidate 基于 releaseId 二次核验并拒绝预发布', async () => {
    const h = createHarness();
    h.fetchReleaseById.mockResolvedValue(fixture.release);

    const candidate: UpdateCandidate = await h.buildService().getVerifiedCandidate(42, version);
    expect(candidate.version).toBe('1.1.0');

    h.fetchReleaseById.mockResolvedValue({ ...fixture.release, tag_name: 'v2.0.0-beta.1' });
    await expect(h.buildService().getVerifiedCandidate(42, version)).rejects.toMatchObject({
      updateFailureReason: 'release_mismatch',
    });
  });
});

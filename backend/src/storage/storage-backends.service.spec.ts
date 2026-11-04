import { BadRequestException } from '@nestjs/common';
import {
  StorageBackendsService,
  validateBackendConfig,
  validateBackendCredential,
} from './storage-backends.service';
import { StorageAccountSchedulerService } from './storage-account-scheduler.service';
import { StorageDriverRegistry } from './storage-driver.registry';
import { StorageCredentialService } from './storage-credential.service';
import type { StorageBackendDriver } from './storage.types';

describe('validateBackendConfig / validateBackendCredential（入口校验）', () => {
  it('S3 配置必填 bucket/region，endpoint 必须 http(s)', () => {
    expect(() => validateBackendConfig('s3', { region: 'us-east-1' })).toThrow(BadRequestException);
    expect(() => validateBackendConfig('s3', { bucket: 'b' })).toThrow(BadRequestException);
    expect(() => validateBackendConfig('s3', { bucket: 'b', region: 'r', endpoint: 'ftp://x' })).toThrow(BadRequestException);
    const config = validateBackendConfig('s3', { bucket: 'b', region: 'r', endpoint: 'https://x', prefix: '/p/' });
    expect(config).toMatchObject({ bucket: 'b', region: 'r', endpoint: 'https://x', prefix: 'p' });
  });

  it('WebDAV 配置必填合法 URL，去尾斜杠', () => {
    expect(() => validateBackendConfig('webdav', { url: 'notaurl' })).toThrow(BadRequestException);
    expect(validateBackendConfig('webdav', { url: 'https://host/dav/' })).toMatchObject({ url: 'https://host/dav' });
  });

  it('凭据缺字段直接 400（错误信息不回显凭据值）', () => {
    expect(() => validateBackendCredential('s3', { accessKeyId: 'x' })).toThrow('secretAccessKey');
    expect(() => validateBackendCredential('webdav', { username: 'u', password: '' })).toThrow('password');
    expect(() => validateBackendCredential('gdrive', {})).toThrow('refreshToken');
    expect(validateBackendCredential('s3', { accessKeyId: 'x', secretAccessKey: 'y' })).toBeTruthy();
  });

  it('telegram 不是本表管理的后端类型', () => {
    expect(() => validateBackendConfig('telegram' as never, {})).toThrow(BadRequestException);
  });
});

function makeService(opts: {
  credentialAvailable?: boolean;
  probeOk?: boolean;
  rows?: Record<string, unknown>[];
} = {}) {
  const saved: Record<string, unknown>[] = [];
  const repo = {
    find: jest.fn(async () => opts.rows ?? []),
    findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
      (opts.rows ?? []).find((row) => row.id === where.id) ?? null),
    create: jest.fn((input: Record<string, unknown>) => ({ ...input })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      const withId = { id: row.id ?? 'new-id', createdAt: new Date(), updatedAt: new Date(), ...row };
      saved.push(withId);
      return withId;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const credential = {
    isAvailable: jest.fn(() => opts.credentialAvailable !== false),
    cipherVersion: jest.fn(() => 'v1'),
    encryptCredential: jest.fn((payload: Record<string, unknown>) =>
      opts.credentialAvailable === false ? null : `cipher:${JSON.stringify(payload)}`),
    decryptCredential: jest.fn((cipher: string) => {
      if (!cipher?.startsWith('cipher:')) return null;
      return JSON.parse(cipher.slice(7));
    }),
  } as unknown as StorageCredentialService;
  const scheduler = new StorageAccountSchedulerService();
  const registry = new StorageDriverRegistry();
  const driver: StorageBackendDriver = {
    type: 's3',
    upload: jest.fn(),
    openDownloadStream: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn(),
    probeAccount: jest.fn().mockResolvedValue({ ok: opts.probeOk !== false, error: opts.probeOk === false ? '连接被拒绝' : undefined }),
  };
  registry.register(driver);
  const service = new StorageBackendsService(repo as never, credential, scheduler, registry);
  return { service, repo, credential, scheduler, registry, driver, saved };
}

const createInput = {
  type: 's3' as const,
  name: 'minio-1',
  config: { bucket: 'b', region: 'r' },
  credential: { accessKeyId: 'ak', secretAccessKey: 'sk' },
};

describe('StorageBackendsService（创建即测试 / fail-closed / 撤销语义）', () => {
  it('根密钥缺失时拒绝创建（绝不落明文）', async () => {
    const { service, repo } = makeService({ credentialAvailable: false });
    await expect(service.create(createInput, 'admin')).rejects.toThrow('STORAGE_ENCRYPTION_KEY');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('连通性测试失败不落库', async () => {
    const { service, repo } = makeService({ probeOk: false });
    await expect(service.create(createInput, 'admin')).rejects.toThrow('连通性测试失败');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('创建成功：凭据只存密文，视图不含凭据', async () => {
    const { service, saved } = makeService();
    const view = await service.create(createInput, 'admin');
    expect(saved[0].credentialCiphertext).toContain('cipher:');
    expect(JSON.stringify(view)).not.toContain('sk');
    expect(view.hasCredential).toBe(true);
    expect(view.status).toBe('active');
  });

  it('撤销：清凭据停任务但保留行（存量文件引用可诊断）', async () => {
    const rows = [{
      id: 'a', type: 's3', name: 'n', status: 'active', enabled: true, weight: 1, maxInflight: 8,
      config: {}, credentialCiphertext: 'cipher:{"accessKeyId":"ak","secretAccessKey":"sk"}',
      quotaTotalBytes: null, quotaUsedBytes: null, lastQuotaCheckAt: null,
    }];
    const { service, scheduler } = makeService({ rows });
    await service.refresh();
    const view = await service.revoke('a', 'admin');
    expect(view.status).toBe('revoked');
    expect(view.enabled).toBe(false);
    expect(view.hasCredential).toBe(false);
    expect(scheduler.activeAccountIds('s3')).toEqual([]);
    // 行仍在（findOne 可查到），回源侧据此返回可诊断失败而非「文件消失」
    expect(await service.findById('a')).toBeTruthy();
  });

  it('resolveContext：撤销账号返回 null；正常账号解密成功并缓存', async () => {
    const rows = [{
      id: 'a', type: 's3', name: 'n', status: 'active', enabled: true,
      config: { bucket: 'b' }, credentialCiphertext: 'cipher:{"accessKeyId":"ak","secretAccessKey":"sk"}',
    }];
    const { service, credential } = makeService({ rows });
    const ctx = await service.resolveContext('a');
    expect(ctx?.credential).toEqual({ accessKeyId: 'ak', secretAccessKey: 'sk' });
    await service.resolveContext('a');
    expect(credential.decryptCredential).toHaveBeenCalledTimes(1); // 缓存命中
    rows[0].status = 'revoked';
    (service as never as { contextCache: Map<string, unknown> }).contextCache.clear();
    expect(await service.resolveContext('a')).toBeNull();
  });

  it('auth 类失败立即转 degraded 并落库（不受 30s 节流限制）', async () => {
    const rows = [{ id: 'a', type: 's3', name: 'n', status: 'active', enabled: true, config: {} }];
    const { service, repo } = makeService({ rows });
    await service.recordOutcome('a', { ok: false, failureKind: 'auth', errorMessage: '403' });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'a', status: 'active' },
      expect.objectContaining({ status: 'degraded', lastFailureCode: 'auth' }),
    );
  });

  it('GDrive 邮箱视图脱敏', () => {
    const { service } = makeService();
    const view = service.toView({
      id: 'a', type: 'gdrive', name: 'n', status: 'active', enabled: true, weight: 1, maxInflight: 8,
      config: { email: 'someone@gmail.com' }, credentialCiphertext: null, credentialVersion: null,
      quotaTotalBytes: 15 * 1024 ** 3, quotaUsedBytes: 1024, lastQuotaCheckAt: null,
      lastHealthCheckAt: null, lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null,
      lastFailureSummary: null, note: null, createdAt: new Date(), updatedAt: new Date(),
    } as never);
    expect((view.config as { email: string }).email).toBe('s***@gmail.com');
  });

  it('容量耗尽告警：委托 AlertEngine（STORAGE_CAPACITY_EXHAUSTED）；引擎缺失/异常不阻断', async () => {
    const { service, repo, credential, scheduler, registry } = makeService();
    const createAlerts = jest.fn().mockResolvedValue([]);
    const withEngine = new StorageBackendsService(
      repo as never, credential, scheduler, registry, { createAlerts } as never,
    );
    await withEngine.raiseCapacityExhaustedAlert('gdrive', 3);
    expect(createAlerts).toHaveBeenCalledWith([
      expect.objectContaining({
        ruleId: 'STORAGE_CAPACITY_EXHAUSTED',
        level: 'critical',
        context: { backendType: 'gdrive', activeAccounts: 3 },
      }),
    ]);

    // 引擎未装配：静默 no-op
    await service.raiseCapacityExhaustedAlert('gdrive', 1);

    // 引擎异常：吞掉不阻断（best-effort）
    const failing = new StorageBackendsService(
      repo as never, credential, scheduler, registry,
      { createAlerts: jest.fn().mockRejectedValue(new Error('db down')) } as never,
    );
    await expect(failing.raiseCapacityExhaustedAlert('gdrive', 1)).resolves.toBeUndefined();
  });
});
import { Readable } from 'stream';
import { StorageAccountSchedulerService } from './storage-account-scheduler.service';
import { StorageDriverRegistry } from './storage-driver.registry';
import { StorageRouterService, STORAGE_DEFAULT_BACKEND_KEY } from './storage-router.service';
import {
  StorageAccountError,
  StorageBackendDriver,
  StorageDownloadUnavailableError,
} from './storage.types';
import type { StorageBackend } from '../common/entities/storage-backend.entity';

function makeAccount(id: string, type: 's3' | 'webdav' | 'gdrive' = 's3'): StorageBackend {
  return {
    id, type, name: id, status: 'active', enabled: true, weight: 1, maxInflight: 4,
    config: null, credentialCiphertext: 'cipher', credentialVersion: 'v1',
    quotaTotalBytes: null, quotaUsedBytes: null, lastQuotaCheckAt: null,
  } as StorageBackend;
}

function makeDriver(type: 's3' | 'webdav' | 'gdrive', overrides: Partial<StorageBackendDriver> = {}): StorageBackendDriver {
  return {
    type,
    upload: jest.fn().mockResolvedValue({ objectRef: `ref-${type}`, size: 1024 }),
    openDownloadStream: jest.fn().mockResolvedValue({ stream: Readable.from(['data']), size: 1024 }),
    headObject: jest.fn().mockResolvedValue({ exists: true, size: 1024 }),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    probeAccount: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as StorageBackendDriver;
}

function makeRouter(opts: {
  defaultBackend?: string;
  accounts?: StorageBackend[];
  driver?: StorageBackendDriver;
  resolveContext?: jest.Mock;
} = {}) {
  const configCache = {
    get: jest.fn(async (key: string, fallback: string) =>
      key === STORAGE_DEFAULT_BACKEND_KEY ? (opts.defaultBackend ?? fallback) : fallback),
  };
  const scheduler = new StorageAccountSchedulerService();
  scheduler.syncAccounts(opts.accounts ?? [makeAccount('a'), makeAccount('b')]);
  const registry = new StorageDriverRegistry();
  const driver = opts.driver ?? makeDriver('s3');
  registry.register(driver);
  const backends = {
    resolveContext: opts.resolveContext ?? jest.fn(async (id: string) => ({
      accountId: id, type: 's3', config: {}, credential: {},
    })),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    refreshQuota: jest.fn().mockResolvedValue(null),
    raiseCapacityExhaustedAlert: jest.fn().mockResolvedValue(undefined),
  };
  const router = new StorageRouterService(configCache as never, backends as never, scheduler, registry);
  return { router, scheduler, registry, backends, driver, configCache };
}

describe('StorageRouterService（路由 / 换号 / fail-closed）', () => {
  it('默认后端缺省 telegram；配置非 TG 但无账号时安全回退', async () => {
    const { router } = makeRouter({ defaultBackend: 'telegram', accounts: [] });
    expect(await router.getDefaultBackendType()).toBe('telegram');

    const { router: router2 } = makeRouter({ defaultBackend: 's3', accounts: [] });
    expect(await router2.getDefaultBackendType()).toBe('telegram');

    const { router: router3 } = makeRouter({ defaultBackend: 's3' });
    expect(await router3.getDefaultBackendType()).toBe('s3');
  });

  it('上传成功返回实际账号与对象引用，并回报采样', async () => {
    const { router, backends, scheduler } = makeRouter();
    const receipt = await router.upload({
      backendType: 's3',
      objectName: 'file.bin',
      knownLength: 1024,
      openStream: () => Readable.from(['data']),
    });
    expect(receipt.backendType).toBe('s3');
    expect(receipt.objectRef).toBe('ref-s3');
    expect(['a', 'b']).toContain(receipt.accountId);
    expect(backends.recordOutcome).toHaveBeenCalledWith(receipt.accountId, { ok: true });
    expect(scheduler.getRuntime(receipt.accountId!)!.inflight).toBe(0);
  });

  it('上传失败自动换号（最多 3 次尝试），失败账号进入冷却', async () => {
    const driver = makeDriver('s3', {
      upload: jest.fn()
        .mockRejectedValueOnce(new StorageAccountError('限流', 'flood', 429))
        .mockResolvedValueOnce({ objectRef: 'ok-ref', size: 1024 }),
    });
    const { router, scheduler } = makeRouter({ driver });
    const receipt = await router.upload({
      backendType: 's3',
      objectName: 'file.bin',
      knownLength: 1024,
      openStream: () => Readable.from(['data']),
    });
    expect(receipt.objectRef).toBe('ok-ref');
    expect(driver.upload).toHaveBeenCalledTimes(2);
    const cooled = ['a', 'b'].filter((id) => scheduler.getRuntime(id)!.cooldownUntil > Date.now());
    expect(cooled.length).toBe(1);
  });

  it('全部候选不可调度（未发出请求）时抛 admissionOnly 可重试错误', async () => {
    const { router, scheduler } = makeRouter();
    // 占满两个账号的在飞名额
    scheduler.beginAttempt('a');
    scheduler.beginAttempt('b');
    scheduler.beginAttempt('a');
    scheduler.beginAttempt('b');
    scheduler.beginAttempt('a');
    scheduler.beginAttempt('b');
    scheduler.beginAttempt('a');
    scheduler.beginAttempt('b');
    await expect(router.upload({
      backendType: 's3',
      objectName: 'f',
      knownLength: 1,
      openStream: () => Readable.from([]),
    })).rejects.toMatchObject({ admissionOnly: true });
  });

  it('凭据不可解析的账号按 auth 失败换号', async () => {
    const resolveContext = jest.fn(async (id: string) =>
      id === 'a' ? null : { accountId: id, type: 's3', config: {}, credential: {} });
    const { router } = makeRouter({ resolveContext });
    const receipt = await router.upload({
      backendType: 's3',
      objectName: 'f',
      knownLength: 1,
      openStream: () => Readable.from(['x']),
    });
    expect(receipt.accountId).toBe('b');
  });

  it('回源：对象所属账号唯一候选，流结束后自动记账', async () => {
    const { router, scheduler } = makeRouter();
    const result = await router.openDownloadStream({
      backendType: 's3', accountId: 'a', objectRef: 'ref', expectedSize: 1024,
    });
    expect(scheduler.getRuntime('a')!.inflight).toBe(1);
    expect(result.size).toBe(1024);
    await new Promise<void>((resolve) => {
      result.stream.on('end', resolve);
      result.stream.resume();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduler.getRuntime('a')!.inflight).toBe(0);
  });

  it('回源 fail-closed：账号不在池内/冷却中返回可诊断 503，绝不跨账号', async () => {
    const { router, scheduler } = makeRouter();
    await expect(router.openDownloadStream({
      backendType: 's3', accountId: 'ghost', objectRef: 'ref',
    })).rejects.toBeInstanceOf(StorageDownloadUnavailableError);

    const now = Date.now();
    scheduler.beginAttempt('a', now);
    scheduler.finishAttempt('a', { ok: false, failureKind: 'flood' }, now);
    await expect(router.openDownloadStream({
      backendType: 's3', accountId: 'a', objectRef: 'ref',
    })).rejects.toMatchObject({ reason: 'account_busy' });
    // 绝不尝试 b 账号
    expect(scheduler.getRuntime('b')!.inflight).toBe(0);
  });

  it('回源凭据失效：名额归还且返回 credential_unavailable', async () => {
    const resolveContext = jest.fn().mockResolvedValue(null);
    const { router, scheduler } = makeRouter({ resolveContext });
    await expect(router.openDownloadStream({
      backendType: 's3', accountId: 'a', objectRef: 'ref',
    })).rejects.toMatchObject({ reason: 'credential_unavailable' });
    expect(scheduler.getRuntime('a')!.inflight).toBe(0);
  });

  it('deleteRemoteObject best-effort：失败返回 false 不抛异常', async () => {
    const driver = makeDriver('s3', {
      deleteObject: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const { router } = makeRouter({ driver });
    expect(await router.deleteRemoteObject('s3', 'a', 'ref')).toBe(false);
    expect(await router.deleteRemoteObject('s3', 'ghost', 'ref')).toBe(false);
  });

  it('headObject 凭据不可用时抛出异常（不伪装成对象缺失）', async () => {
    const resolveContext = jest.fn().mockResolvedValue(null);
    const { router } = makeRouter({ resolveContext });
    await expect(router.headObject('s3', 'a', 'ref'))
      .rejects.toBeInstanceOf(StorageDownloadUnavailableError);
  });

  it('abort 信号：上传立即取消且不消耗失败冷却', async () => {
    const { router } = makeRouter();
    const controller = new AbortController();
    controller.abort();
    await expect(router.upload({
      backendType: 's3',
      objectName: 'f',
      knownLength: 1,
      openStream: () => Readable.from([]),
      signal: controller.signal,
    })).rejects.toThrow('上传已取消');
  });

  it('GDrive 全部账号配额耗尽：上传 503 且触发容量告警（复用 alert 模块）', async () => {
    const GB = 1024 ** 3;
    const accounts = [
      { ...makeAccount('a', 'gdrive'), quotaTotalBytes: 15 * GB, quotaUsedBytes: 15 * GB, lastQuotaCheckAt: new Date() },
      { ...makeAccount('b', 'gdrive'), quotaTotalBytes: 15 * GB, quotaUsedBytes: 15 * GB, lastQuotaCheckAt: new Date() },
    ];
    const { router, backends } = makeRouter({ accounts, driver: makeDriver('gdrive') });
    await expect(router.upload({
      backendType: 'gdrive',
      objectName: 'f',
      knownLength: 10 * 1024 * 1024,
      openStream: () => Readable.from([]),
    })).rejects.toMatchObject({ admissionOnly: true });
    expect(backends.raiseCapacityExhaustedAlert).toHaveBeenCalledWith('gdrive', 2);
  });

  it('GDrive 仅因冷却/满载不可调度（配额充足）：不误报容量告警', async () => {
    const GB = 1024 ** 3;
    const accounts = [
      { ...makeAccount('a', 'gdrive'), quotaTotalBytes: 15 * GB, quotaUsedBytes: 1 * GB, lastQuotaCheckAt: new Date() },
    ];
    const { router, backends, scheduler } = makeRouter({ accounts, driver: makeDriver('gdrive') });
    const now = Date.now();
    scheduler.beginAttempt('a', now);
    scheduler.finishAttempt('a', { ok: false, failureKind: 'flood' }, now);
    await expect(router.upload({
      backendType: 'gdrive',
      objectName: 'f',
      knownLength: 1024,
      openStream: () => Readable.from([]),
    })).rejects.toMatchObject({ admissionOnly: true });
    expect(backends.raiseCapacityExhaustedAlert).not.toHaveBeenCalled();
  });

  it('S3/WebDAV 无配额概念：选号耗尽不触发容量告警', async () => {
    const { router, backends, scheduler } = makeRouter();
    const now = Date.now();
    for (const id of ['a', 'b']) {
      scheduler.beginAttempt(id, now);
      scheduler.finishAttempt(id, { ok: false, failureKind: 'flood' }, now);
    }
    await expect(router.upload({
      backendType: 's3',
      objectName: 'f',
      knownLength: 1,
      openStream: () => Readable.from([]),
    })).rejects.toMatchObject({ admissionOnly: true });
    expect(backends.raiseCapacityExhaustedAlert).not.toHaveBeenCalled();
  });
  it('GDrive 单文件超出单账号最大可用容量上限时 fail-fast（admissionOnly 为 false，防止 worker 饥饿死循环）', async () => {
    const GB = 1024 ** 3;
    const accounts = [
      { ...makeAccount('a', 'gdrive'), quotaTotalBytes: 15 * GB, quotaUsedBytes: 0, lastQuotaCheckAt: new Date() },
    ];
    const { router } = makeRouter({ accounts, driver: makeDriver('gdrive') });

    // 14GB 文件：需要 14 * 1.2 + 0.25GB = 17.05GB > 15GB，即使账号 100% 空闲也装不下
    await expect(router.upload({
      backendType: 'gdrive',
      objectName: 'massive.iso',
      knownLength: 14 * GB,
      openStream: () => Readable.from([]),
    })).rejects.toMatchObject({
      admissionOnly: false,
      message: expect.stringContaining('超出单 GDrive 账号最大存储上限'),
    });
  });

  it('GDrive 拥有无限容量账号（Workspace，quotaTotalBytes === null）时不施加单账号上限', async () => {
    const GB = 1024 ** 3;
    const accounts = [
      { ...makeAccount('ws', 'gdrive'), quotaTotalBytes: null, quotaUsedBytes: 0, lastQuotaCheckAt: new Date() },
    ];
    const uploadMock = jest.fn().mockResolvedValue({ objectRef: 'obj-large', size: 20 * GB });
    const { router } = makeRouter({ accounts, driver: makeDriver('gdrive', { upload: uploadMock }) });

    const result = await router.upload({
      backendType: 'gdrive',
      objectName: 'huge-20gb.iso',
      knownLength: 20 * GB,
      openStream: () => Readable.from([]),
    });
    expect(result.objectRef).toBe('obj-large');
    expect(uploadMock).toHaveBeenCalled();
  });

  it('客户端主动中止取流（AbortError）时不惩罚健康账号进入 cooldown（P1-01 防护）', async () => {
    const stream = new Readable({ read() {} });
    const driver = makeDriver('s3', {
      openDownloadStream: jest.fn().mockResolvedValue({ stream, size: 1024 }),
    });
    const { router, scheduler, backends } = makeRouter({ driver });

    const download = await router.openDownloadStream({
      backendType: 's3',
      accountId: 'a',
      objectRef: 'ref',
      expectedSize: 1024,
    });

    // 模拟客户端主动断开连接触发 AbortError
    const abortErr: any = new Error('The user aborted a request.');
    abortErr.name = 'AbortError';
    download.stream.emit('error', abortErr);

    // 账号名额已释放
    expect(scheduler.getRuntime('a')!.inflight).toBe(0);
    // 账号未进入 cooldown，也未被记录为失败
    expect(scheduler.getRuntime('a')!.cooldownUntil).toBe(0);
    expect(backends.recordOutcome).not.toHaveBeenCalledWith('a', expect.objectContaining({ ok: false }));
  });

  it('isGDriveCacheModeEnabled 必须配置开启且 GDrive 有可用账号', async () => {
    const { router, configCache, scheduler } = makeRouter({ accounts: [] });
    expect(await router.isGDriveCacheModeEnabled()).toBe(false);

    configCache.get.mockImplementation(async (key: string, fallback: string) => {
      if (key === 'STORAGE_GDRIVE_CACHE_MODE') return 'true';
      return fallback;
    });
    // 无 GDrive 账号仍返回 false
    expect(await router.isGDriveCacheModeEnabled()).toBe(false);

    // 同步 1 个 active GDrive 账号后变为 true
    scheduler.syncAccounts([makeAccount('gd-1', 'gdrive')]);
    expect(await router.isGDriveCacheModeEnabled()).toBe(true);
  });

  it('getGDriveChunkSizeBytes 返回合法分块大小（默认 16MB，有效 8/16/32/64）', async () => {
    const { router, configCache } = makeRouter();
    expect(await router.getGDriveChunkSizeBytes()).toBe(16 * 1024 * 1024);

    configCache.get.mockImplementation(async (key: string, fallback: string) => {
      if (key === 'STORAGE_GDRIVE_CHUNK_SIZE_MB') return '32';
      return fallback;
    });
    expect(await router.getGDriveChunkSizeBytes()).toBe(32 * 1024 * 1024);
  });
});

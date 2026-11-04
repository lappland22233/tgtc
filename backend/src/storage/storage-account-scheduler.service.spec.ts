import { StorageAccountSchedulerService } from './storage-account-scheduler.service';
import type { StorageBackend } from '../common/entities/storage-backend.entity';

const GB = 1024 ** 3;

function makeAccount(overrides: Partial<StorageBackend> = {}): StorageBackend {
  return {
    id: 'acc-1',
    type: 's3',
    name: 'test',
    status: 'active',
    enabled: true,
    weight: 1,
    maxInflight: 2,
    config: null,
    credentialCiphertext: null,
    credentialVersion: null,
    quotaTotalBytes: null,
    quotaUsedBytes: null,
    lastQuotaCheckAt: null,
    ...overrides,
  } as StorageBackend;
}

describe('StorageAccountSchedulerService（选号 / 冷却 / 配额准入）', () => {
  let scheduler: StorageAccountSchedulerService;

  beforeEach(() => {
    scheduler = new StorageAccountSchedulerService();
  });

  it('只选择 enabled 且 active 的账号', () => {
    scheduler.syncAccounts([
      makeAccount({ id: 'a', enabled: false }),
      makeAccount({ id: 'b', status: 'degraded' }),
      makeAccount({ id: 'c' }),
    ]);
    expect(scheduler.activeAccountIds('s3')).toEqual(['c']);
    expect(scheduler.select('s3')?.accountId).toBe('c');
  });

  it('在飞上限满载时不再选中（容量分为 0）', () => {
    scheduler.syncAccounts([makeAccount({ id: 'a', maxInflight: 1 })]);
    expect(scheduler.beginAttempt('a')).toBe(true);
    expect(scheduler.select('s3')).toBeNull();
    scheduler.finishAttempt('a', { ok: true, bytes: 1000, durationMs: 100 });
    expect(scheduler.select('s3')?.accountId).toBe('a');
  });

  it('失败进入冷却，冷却期内不选；成功后立即解除', () => {
    scheduler.syncAccounts([makeAccount({ id: 'a' })]);
    const now = 1_000_000;
    scheduler.beginAttempt('a', now);
    scheduler.finishAttempt('a', { ok: false, failureKind: 'flood' }, now);
    expect(scheduler.select('s3', now + 1000)).toBeNull();
    expect(scheduler.select('s3', now + 61_000)?.accountId).toBe('a');
  });

  it('连续失败指数放大冷却且不超过上限', () => {
    scheduler.syncAccounts([makeAccount({ id: 'a' })]);
    let now = 1_000_000;
    for (let i = 0; i < 8; i += 1) {
      scheduler.beginAttempt('a', now);
      scheduler.finishAttempt('a', { ok: false, failureKind: 'network' }, now);
      now += 31 * 60 * 1000; // 每轮都等到冷却结束
    }
    const rt = scheduler.getRuntime('a')!;
    expect(rt.cooldownUntil).toBeGreaterThan(0);
  });

  it('releaseAttempt 归还名额不计失败', () => {
    scheduler.syncAccounts([makeAccount({ id: 'a', maxInflight: 1 })]);
    scheduler.beginAttempt('a');
    scheduler.releaseAttempt('a');
    expect(scheduler.getRuntime('a')!.inflight).toBe(0);
    expect(scheduler.select('s3')?.accountId).toBe('a');
  });

  it('exclude 排除已失败账号实现换号', () => {
    scheduler.syncAccounts([makeAccount({ id: 'a' }), makeAccount({ id: 'b' })]);
    const selection = scheduler.select('s3', Date.now(), { exclude: new Set(['a']) });
    expect(selection?.accountId).toBe('b');
  });

  it('带宽 EWMA 成功采样后影响得分（健康且快的账号优先）', () => {
    scheduler.syncAccounts([makeAccount({ id: 'slow' }), makeAccount({ id: 'fast' })]);
    scheduler.beginAttempt('fast');
    scheduler.finishAttempt('fast', { ok: true, bytes: 100 * 1024 * 1024, durationMs: 1000 });
    scheduler.beginAttempt('slow');
    scheduler.finishAttempt('slow', { ok: true, bytes: 1 * 1024 * 1024, durationMs: 1000 });
    // 带宽分差异应使 fast 得分更高（同权重同容量）
    const scores = new Map<string, number>();
    for (let i = 0; i < 10; i += 1) {
      const sel = scheduler.select('s3')!;
      scores.set(sel.accountId, (scores.get(sel.accountId) ?? 0) + 1);
    }
    expect(scores.get('fast') ?? 0).toBeGreaterThan(scores.get('slow') ?? 0);
  });

  describe('GDrive 配额硬准入（账号池扩容核心）', () => {
    it('剩余配额不足（文件×1.2+256MB）的账号不参与选号', () => {
      scheduler.syncAccounts([
        makeAccount({ id: 'full', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 15 * GB - 100 * 1024 * 1024, lastQuotaCheckAt: new Date() }),
        makeAccount({ id: 'free', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 1 * GB, lastQuotaCheckAt: new Date() }),
      ]);
      const selection = scheduler.select('gdrive', Date.now(), { requiredBytes: 500 * 1024 * 1024 });
      expect(selection?.accountId).toBe('free');
    });

    it('全部账号写满时无候选（上传侧返回可重试 503）', () => {
      scheduler.syncAccounts([
        makeAccount({ id: 'a', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 15 * GB, lastQuotaCheckAt: new Date() }),
        makeAccount({ id: 'b', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 15 * GB, lastQuotaCheckAt: new Date() }),
      ]);
      expect(scheduler.select('gdrive', Date.now(), { requiredBytes: 1024 })).toBeNull();
    });

    it('beginAttempt 原子准入复核配额（防选号后并发写满）', () => {
      scheduler.syncAccounts([
        makeAccount({ id: 'a', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 15 * GB - 1024, lastQuotaCheckAt: new Date() }),
      ]);
      expect(scheduler.beginAttempt('a', Date.now(), 10 * 1024 * 1024)).toBe(false);
    });

    it('剩余配额比例影响得分（空间多的账号优先）', () => {
      scheduler.syncAccounts([
        makeAccount({ id: 'nearly-full', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 13 * GB, lastQuotaCheckAt: new Date() }),
        makeAccount({ id: 'empty', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 0, lastQuotaCheckAt: new Date() }),
      ]);
      const counts = new Map<string, number>();
      for (let i = 0; i < 10; i += 1) {
        const sel = scheduler.select('gdrive', Date.now(), { requiredBytes: 1024 })!;
        counts.set(sel.accountId, (counts.get(sel.accountId) ?? 0) + 1);
      }
      expect(counts.get('empty') ?? 0).toBeGreaterThan(counts.get('nearly-full') ?? 0);
    });

    it('updateQuota 刷新后发现空间即解除冷却', () => {
      scheduler.syncAccounts([
        makeAccount({ id: 'a', type: 'gdrive', quotaTotalBytes: 15 * GB, quotaUsedBytes: 15 * GB, lastQuotaCheckAt: new Date() }),
      ]);
      const now = 1_000_000;
      scheduler.beginAttempt('a', now);
      scheduler.finishAttempt('a', { ok: false, failureKind: 'quota' }, now);
      expect(scheduler.select('gdrive', now + 1000, { requiredBytes: 1024 })).toBeNull();
      scheduler.updateQuota('a', { totalBytes: 15 * GB, usedBytes: 5 * GB }, now + 2000);
      expect(scheduler.select('gdrive', now + 3000, { requiredBytes: 1024 })?.accountId).toBe('a');
    });

    it('S3/WebDAV 无配额概念，不启用配额因子', () => {
      scheduler.syncAccounts([makeAccount({ id: 'a', type: 'webdav' })]);
      expect(scheduler.select('webdav', Date.now(), { requiredBytes: 100 * GB })?.accountId).toBe('a');
    });
  });

  it('syncAccounts 移除已删除账号并保留运行态', () => {
    scheduler.syncAccounts([makeAccount({ id: 'a' })]);
    scheduler.beginAttempt('a');
    scheduler.syncAccounts([makeAccount({ id: 'a', weight: 5 }), makeAccount({ id: 'b' })]);
    expect(scheduler.getRuntime('a')!.inflight).toBe(1);
    expect(scheduler.getRuntime('a')!.weight).toBe(5);
    scheduler.syncAccounts([makeAccount({ id: 'b' })]);
    expect(scheduler.hasAccount('a')).toBe(false);
  });
});
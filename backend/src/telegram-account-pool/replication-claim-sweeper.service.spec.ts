import 'reflect-metadata';
import { ReplicationClaimSweeperService } from './replication-claim-sweeper.service';

/**
 * B-13：认领窗口清扫此前零直接测试。
 *
 * 它是「中继成功 → 群内 Bot 认领」唯一的结算入口：下载路径已不再触发扩散，
 * 若清扫失效，waiting_claims 会永久停放，后台看到「中继成功但永远没有结论」，
 * 认领超时告警也永远不触发。
 */
function makeAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    ownerType: 'file',
    ownerId: 'f1',
    targetChatId: '-1001',
    desiredCount: 3,
    baselineReadyCount: 1,
    ...overrides,
  };
}

function makeService(opts: {
  due?: any[];
  dueError?: unknown;
  readyAccountIds?: string[];
  settleStatus?: string;
  settleError?: unknown;
  desiredReplicas?: number;
} = {}) {
  const attempts = {
    listDueClaimWindows: jest.fn().mockImplementation(async () => {
      if (opts.dueError) throw opts.dueError;
      return opts.due ?? [];
    }),
    settleClaims: jest.fn().mockImplementation(async () => {
      if (opts.settleError) throw opts.settleError;
      return { status: opts.settleStatus ?? 'succeeded' };
    }),
  };
  const copies = {
    readyAccountIds: jest.fn().mockResolvedValue(opts.readyAccountIds ?? ['bot-a', 'bot-b']),
  };
  const replicaTargets = {
    // 区分 undefined（用默认 5）与显式 null（测回退分支）
    desiredReplicas: jest.fn().mockResolvedValue(opts.desiredReplicas === undefined ? 5 : opts.desiredReplicas),
  };
  const pool = { bumpCounter: jest.fn() };
  const service = new ReplicationClaimSweeperService(
    attempts as any, copies as any, replicaTargets as any, pool as any,
  );
  (service as any).logger = { warn: jest.fn(), log: jest.fn() };
  return { service, attempts, copies, replicaTargets, pool };
}

describe('ReplicationClaimSweeperService（B-13）', () => {
  it('无到期轮次时返回 0 且不结算', async () => {
    const { service, attempts } = makeService({ due: [] });
    await expect(service.sweepOnce()).resolves.toBe(0);
    expect(attempts.settleClaims).not.toHaveBeenCalled();
  });

  it('目标数以轮次开立时的快照为准，不被中途改配置改写', async () => {
    const { service, attempts, replicaTargets } = makeService({
      due: [makeAttempt({ desiredCount: 3 })],
      desiredReplicas: 8,
    });

    await expect(service.sweepOnce()).resolves.toBe(1);

    expect(attempts.settleClaims).toHaveBeenCalledWith('a1', expect.objectContaining({
      desiredCount: 3,
      baselineReadyCount: 1,
      readyAccountIds: ['bot-a', 'bot-b'],
    }));
    expect(replicaTargets.desiredReplicas).not.toHaveBeenCalled();
  });

  it('desiredCount=0 的历史行回退到当前配置，且至少为 1', async () => {
    const { service, attempts } = makeService({
      due: [makeAttempt({ desiredCount: 0 })],
      desiredReplicas: 4,
    });
    await service.sweepOnce();
    expect(attempts.settleClaims).toHaveBeenCalledWith('a1', expect.objectContaining({ desiredCount: 4 }));
  });

  it('当前配置返回 null 时回退为 1，不产生 0 目标', async () => {
    const { service, attempts } = makeService({
      due: [makeAttempt({ desiredCount: 0 })],
      desiredReplicas: null as any,
    });
    await service.sweepOnce();
    expect(attempts.settleClaims).toHaveBeenCalledWith('a1', expect.objectContaining({ desiredCount: 1 }));
  });

  it('claim_timeout 必须计入 relayClaimsMissed 告警口径', async () => {
    const { service, pool } = makeService({
      due: [makeAttempt()],
      settleStatus: 'claim_timeout',
    });
    await expect(service.sweepOnce()).resolves.toBe(1);
    expect(pool.bumpCounter).toHaveBeenCalledWith('relayClaimsMissed');
    expect((service as any).logger.warn).toHaveBeenCalled();
  });

  it.each(['succeeded', 'partial_success'])('%s 不触发认领超时告警', async (status) => {
    const { service, pool } = makeService({ due: [makeAttempt()], settleStatus: status });
    await service.sweepOnce();
    expect(pool.bumpCounter).not.toHaveBeenCalled();
  });

  it('单条结算失败不影响其它轮次', async () => {
    const due = [makeAttempt({ id: 'bad' }), makeAttempt({ id: 'good' })];
    const { service, attempts, pool } = makeService({ due });
    attempts.settleClaims
      .mockRejectedValueOnce(new Error('db locked'))
      .mockResolvedValueOnce({ status: 'claim_timeout' });

    await expect(service.sweepOnce()).resolves.toBe(1);

    expect(attempts.settleClaims).toHaveBeenCalledTimes(2);
    expect(pool.bumpCounter).toHaveBeenCalledWith('relayClaimsMissed');
  });

  it('整体库故障只记日志并返回 0，绝不抛出影响其它链路', async () => {
    const { service } = makeService({ dueError: new Error('connection refused') });
    await expect(service.sweepOnce()).resolves.toBe(0);
    expect((service as any).logger.warn).toHaveBeenCalled();
  });

  it('重入保护：上一轮未跑完时本轮直接返回 0', async () => {
    const { service, attempts } = makeService({ due: [makeAttempt()] });
    (service as any).running = true;
    await expect(service.sweepOnce()).resolves.toBe(0);
    expect(attempts.listDueClaimWindows).not.toHaveBeenCalled();
  });

  it('失败后 running 必须复位，否则清扫永久停摆', async () => {
    const { service, attempts } = makeService({ dueError: new Error('boom') });
    await service.sweepOnce();
    expect((service as any).running).toBe(false);
    attempts.listDueClaimWindows.mockResolvedValue([makeAttempt()]);
    await expect(service.sweepOnce()).resolves.toBe(1);
  });

  it('单轮批量上限传给仓库，避免一次清扫占用过久', async () => {
    const { service, attempts } = makeService({ due: [] });
    const now = new Date('2026-01-01T00:00:00Z');
    await service.sweepOnce(now);
    expect(attempts.listDueClaimWindows).toHaveBeenCalledWith(50, now);
  });

  it('onModuleInit 幂等；onApplicationShutdown 清理定时器', () => {
    jest.useFakeTimers();
    try {
      const { service } = makeService();
      service.onModuleInit();
      const timer = (service as any).timer;
      expect(timer).toBeTruthy();
      service.onModuleInit();
      expect((service as any).timer).toBe(timer);
      service.onApplicationShutdown();
      expect((service as any).timer).toBeNull();
      expect(() => service.onApplicationShutdown()).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });
});
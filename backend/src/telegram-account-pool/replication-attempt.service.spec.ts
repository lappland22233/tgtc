import { DataSource } from 'typeorm';
// 每个用例都会新建 SQLite 内存库并跑基线迁移；满负载串行执行时会超过 jest 默认 5s
jest.setTimeout(30_000);

const originalDbType = process.env.DB_TYPE;

describe('ReplicationAttemptService（SQLite 内存库）', () => {
  let dataSource: DataSource;

  beforeEach(() => {
    process.env.DB_TYPE = 'sqlite';
    jest.resetModules();
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
  });

  async function setup() {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { databaseEntities } = require('../database/entities') as typeof import('../database/entities');
    const { SqliteEntitySchema1700000000000 } = require('../migrations/0000000000000-SqliteEntitySchema') as typeof import('../migrations/0000000000000-SqliteEntitySchema');
    const { ReplicationAttemptService, ATTEMPT_MERGE_WINDOW_MS, RETRY_MAX_ATTEMPTS } = require('./replication-attempt.service') as typeof import('./replication-attempt.service');
    const { TelegramReplicationAttempt } = require('../common/entities/telegram-replication-attempt.entity') as typeof import('../common/entities/telegram-replication-attempt.entity');
    /* eslint-enable @typescript-eslint/no-var-requires */

    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [...databaseEntities],
      migrations: [SqliteEntitySchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    });
    await dataSource.initialize();

    const repo = dataSource.getRepository(TelegramReplicationAttempt);
    const service = new ReplicationAttemptService(repo);
    const baseInput = {
      ownerType: 'file' as const,
      ownerId: 'file-1',
      desiredCount: 3,
      baselineReadyCount: 1,
    };
    return { service, repo, baseInput, ATTEMPT_MERGE_WINDOW_MS, RETRY_MAX_ATTEMPTS };
  }

  it('开启轮次：新建行并为后续状态迁移保留可重建时间线', async () => {
    const { service, repo, baseInput } = await setup();

    const begin = await service.beginRound(baseInput);
    expect(begin.skipped).toBe(false);
    expect(begin.merged).toBe(false);
    expect(begin.attempt?.status).toBe('planned');
    expect(begin.attempt?.startedAt).toBeInstanceOf(Date);
    expect(await repo.count()).toBe(1);

    const attemptId = begin.attempt!.id;
    await service.markRelayStarted(attemptId);
    await service.markRelaySucceeded(attemptId, {
      relayAccountId: 'user-1',
      relayMessageId: '555',
      claimDeadlineAt: new Date(Date.now() + 12_000),
    });
    const detail = await service.getDetail(attemptId);
    expect(detail?.status).toBe('waiting_claims');
    // 脱敏：账号 / 消息 id 只回传短引用（完整值不出管理接口，定位靠轮次 id）
    expect(detail?.relayAccountId).toBe('user…');
    expect(detail?.relayMessageId).toBe('***');
    expect(detail?.timeline.map((item) => item.label)).toEqual(
      expect.arrayContaining(['轮次开始', '开始执行', '中继转发成功', '认领窗口截止']),
    );
    const relayStep = detail?.timeline.find((item) => item.label === '中继转发成功');
    expect(relayStep?.detail).toContain('user…');
    expect(relayStep?.detail).not.toContain('user-1');
  });

  it('`blocked_manual` 不随懒触发自动重开，但显式重试放行', async () => {
    const { service, repo, baseInput } = await setup();

    const first = await service.beginRound(baseInput);
    await service.finishBlocked(first.attempt!.id, {
      status: 'blocked_manual',
      failureReason: 'permission_denied',
      failureSummary: '用户账号在目标群没有发言权限',
      missingCount: 2,
    });

    // 懒扩散（force=false）一律跳过：不写行、不调 Telegram
    const lazy = await service.beginRound(baseInput);
    expect(lazy.skipped).toBe(true);
    expect(lazy.attempt).toBeNull();
    expect(await repo.count()).toBe(1);

    // 管理员显式重试仍然放行，并记录操作人
    const forced = await service.beginRound({ ...baseInput, force: true, operatorUserId: 'admin-1' });
    expect(forced.attempt).not.toBeNull();
    expect(forced.attempt?.operatorUserId).toBe('admin-1');
    expect(await repo.count()).toBe(2);
  });

  it('重试会把上一轮的执行账号回传给调用方（保证 random_id 稳定去重）', async () => {
    const { service, baseInput } = await setup();

    const first = await service.beginRound(baseInput);
    await service.markRelayStarted(first.attempt!.id);
    await service.markRelaySucceeded(first.attempt!.id, {
      relayAccountId: 'user-9',
      relayMessageId: '777',
      claimDeadlineAt: new Date(Date.now() + 12_000),
    });
    // 窗口内零新增 → claim_timeout（并写入退避 nextRetryAt）
    await service.settleClaims(first.attempt!.id, {
      desiredCount: 3,
      baselineReadyCount: 1,
      readyAccountIds: ['a1'],
    });

    const retry = await service.beginRound({ ...baseInput, force: true, operatorUserId: 'admin-1' });
    expect(retry.previousRelayAccountId).toBe('user-9');
    // 新建行本身不继承账号：账号只作为「优先账号」交给中继去命中服务端去重
    expect(retry.attempt?.relayAccountId).toBeNull();
  });

  it('认领结算：零新增记 claim_timeout，达到目标记 succeeded，有新增未达标记 partial_success', async () => {
    const { service, baseInput } = await setup();

    // 1) 零新增 → claim_timeout（并写入退避时间）
    const timeoutRound = await service.beginRound(baseInput);
    await service.settleClaims(timeoutRound.attempt!.id, {
      desiredCount: 3,
      baselineReadyCount: 1,
      readyAccountIds: ['bot-a'],
    });
    const timeoutDetail = await service.getDetail(timeoutRound.attempt!.id);
    expect(timeoutDetail?.status).toBe('claim_timeout');
    expect(timeoutDetail?.retryable).toBe(true);
    expect(timeoutDetail?.nextRetryAt).not.toBeNull();

    // 2) 新增但未达标 → partial_success
    const partialRound = await service.beginRound({ ...baseInput, ownerId: 'file-2' });
    await service.settleClaims(partialRound.attempt!.id, {
      desiredCount: 3,
      baselineReadyCount: 1,
      readyAccountIds: ['bot-a', 'bot-b'],
    });
    const partialDetail = await service.getDetail(partialRound.attempt!.id);
    expect(partialDetail?.status).toBe('partial_success');
    expect(partialDetail?.retryable).toBe(false);
    expect(partialDetail?.claimedAccountIds).toEqual(['bot-a', 'bot-b']);

    // 3) 达到目标 → succeeded（以轮次记录的期望数为准）
    const okRound = await service.beginRound({ ...baseInput, ownerId: 'file-3', desiredCount: 2 });
    await service.settleClaims(okRound.attempt!.id, {
      desiredCount: 2,
      baselineReadyCount: 1,
      readyAccountIds: ['bot-a', 'bot-b'],
    });
    const okDetail = await service.getDetail(okRound.attempt!.id);
    expect(okDetail?.status).toBe('succeeded');
    expect(okDetail?.missingCount).toBe(0);
  });

  it('退避窗口未到期时新一轮直接跳过且不写行', async () => {
    const { service, repo, baseInput } = await setup();

    const first = await service.beginRound(baseInput);
    await service.finishBlocked(first.attempt!.id, {
      status: 'retryable_failed',
      failureReason: 'network',
      failureSummary: 'network: 连接超时',
      missingCount: 2,
    });
    expect(await repo.count()).toBe(1);

    const skipped = await service.beginRound(baseInput);
    expect(skipped.skipped).toBe(true);
    expect(skipped.attempt).toBeNull();
    expect(await repo.count()).toBe(1);
  });

  it('合并窗口内的重复失败复用既有行并累加 retryCount（控制行数增长）', async () => {
    const { service, repo, baseInput } = await setup();

    const first = await service.beginRound(baseInput);
    await service.finishBlocked(first.attempt!.id, {
      status: 'blocked_not_configured',
      failureReason: 'not_configured',
      failureSummary: 'TELEGRAM_USER_RELAY_ENABLED 未开启',
      missingCount: 2,
    });
    // 清除退避：阻塞类终态本就没有 nextRetryAt，直接再开一轮即应合并
    const second = await service.beginRound(baseInput);
    expect(second.merged).toBe(true);
    expect(second.attempt?.id).toBe(first.attempt?.id);
    expect(second.attempt?.retryCount).toBe(1);
    expect(second.attempt?.status).toBe('planned');
    expect(await repo.count()).toBe(1);
  });

  it('进行中的轮次被复用，不制造重复轮次', async () => {
    const { service, repo, baseInput } = await setup();

    const first = await service.beginRound(baseInput);
    const second = await service.beginRound(baseInput);
    expect(second.merged).toBe(true);
    expect(second.attempt?.id).toBe(first.attempt?.id);
    expect(second.attempt?.retryCount).toBe(0);
    expect(await repo.count()).toBe(1);
  });

  it('手动重试强制新建行并记录操作人与来源轮次', async () => {
    const { service, repo, baseInput } = await setup();

    const first = await service.beginRound(baseInput);
    await service.finishBlocked(first.attempt!.id, {
      status: 'claim_timeout',
      failureReason: 'unknown',
      failureSummary: '认领超时',
      missingCount: 2,
    });

    const manual = await service.beginRound({
      ...baseInput,
      force: true,
      triggeredBy: 'manual',
      operatorUserId: 'admin-1',
      retriedFromId: first.attempt!.id,
    });
    expect(manual.merged).toBe(false);
    expect(manual.attempt?.id).not.toBe(first.attempt?.id);
    expect(manual.attempt?.triggeredBy).toBe('manual');
    expect(manual.attempt?.operatorUserId).toBe('admin-1');
    expect(manual.attempt?.retriedFromId).toBe(first.attempt!.id);
    expect(await repo.count()).toBe(2);
  });

  it('可重试失败达到上限后升级 blocked_manual 并停止自动重试', async () => {
    const { service, repo, baseInput, RETRY_MAX_ATTEMPTS } = await setup();

    const begin = await service.beginRound(baseInput);
    // 直接构造「已重试到上限」的行，避免真实等待退避时间
    await repo.update({ id: begin.attempt!.id }, { retryCount: RETRY_MAX_ATTEMPTS });
    const finished = await service.finishBlocked(begin.attempt!.id, {
      status: 'retryable_failed',
      failureReason: 'rate_limited',
      failureSummary: 'rate_limited: FLOOD_WAIT',
      missingCount: 2,
    });
    expect(finished?.status).toBe('blocked_manual');
    expect(finished?.nextRetryAt).toBeNull();
    expect(finished?.failureSummary).toContain('自动重试已停止');
  });

  it('认领回写：追加到进行中的轮次并按账号去重，无进行中轮次时静默返回', async () => {
    const { service, repo, baseInput } = await setup();

    const begin = await service.beginRound(baseInput);
    await service.recordClaim('file', 'file-1', 'bot-a');
    await service.recordClaim('file', 'file-1', 'bot-a');
    await service.recordClaim('file', 'file-1', 'bot-b');
    const stored = await repo.findOne({ where: { id: begin.attempt!.id } });
    expect(stored?.claimedAccountIds).toEqual(['bot-a', 'bot-b']);

    // 无对应 owner 的轮次：普通备份群消息属正常现象，不得抛错、不得写行
    await service.recordClaim('file', 'unknown-file', 'bot-c');
    expect(await repo.count()).toBe(1);
  });

  it('窗口指标：分类计数、比率、耗时分位与失败原因分布（低样本不下结论）', async () => {
    const { service, repo } = await setup();

    const now = Date.now();
    const seed = async (
      ownerId: string,
      status: string,
      failureReason: string | null,
      relayMs: number | null,
      claimMs: number | null,
    ): Promise<void> => {
      const started = new Date(now - 60_000);
      const relayed = relayMs === null ? null : new Date(started.getTime() + relayMs);
      const completed = relayed === null || claimMs === null ? null : new Date(relayed.getTime() + claimMs);
      const saved = await repo.save(repo.create({
        ownerType: 'file',
        ownerId,
        desiredCount: 2,
        baselineReadyCount: 0,
        status: status as never,
        failureReason: failureReason as never,
        startedAt: started,
        relayCompletedAt: relayed,
        completedAt: completed,
      }));
      // createdAt 由 @CreateDateColumn 生成，这里保持窗口内即可
      expect(saved.id).toBeTruthy();
    };

    await seed('f-ok-1', 'succeeded', null, 1000, 500);
    await seed('f-ok-2', 'succeeded', null, 3000, 700);
    await seed('f-partial', 'partial_success', null, 2000, 600);
    await seed('f-timeout', 'claim_timeout', 'unknown', 1500, null);
    await seed('f-failed', 'retryable_failed', 'network', null, null);
    await seed('f-blocked', 'blocked_not_configured', 'not_configured', null, null);

    const metrics = await service.computeMetrics();
    expect(metrics.attempts).toBe(6);
    expect(metrics.succeeded).toBe(2);
    expect(metrics.partialSuccess).toBe(1);
    expect(metrics.claimTimeouts).toBe(1);
    expect(metrics.relaySucceeded).toBe(4);
    expect(metrics.relayFailed).toBe(1);
    expect(metrics.blocked).toBe(1);
    expect(metrics.sampleSufficient).toBe(true);
    expect(metrics.relaySuccessRate).toBe(0.8);
    expect(metrics.claimRate).toBe(0.75);
    expect(metrics.relayDurationP50Ms).not.toBeNull();
    expect(metrics.relayDurationP95Ms).not.toBeNull();
    expect(metrics.failureReasons).toEqual(
      expect.arrayContaining([
        { reason: 'unknown', count: 1 },
        { reason: 'network', count: 1 },
        { reason: 'not_configured', count: 1 },
      ]),
    );
    // 契约常量：策略 B 不发生文件字节二次传输
    expect(metrics.bytesRelayed).toBe(0);

    // 低样本：样本不足时必须返回 null 而不是伪造 0/1
    const { service: fresh, baseInput: freshInput } = await setup();
    const single = await fresh.beginRound(freshInput);
    await fresh.settleClaims(single.attempt!.id, {
      desiredCount: 3,
      baselineReadyCount: 1,
      readyAccountIds: ['bot-a', 'bot-b'],
    });
    const low = await fresh.computeMetrics();
    expect(low.sampleSufficient).toBe(false);
    expect(low.relaySuccessRate).toBeNull();
    expect(low.claimRate).toBeNull();
  });

  it('清理：先收敛悬挂轮次，再删除保留窗口外的终态行且保留仍在重试窗口内的行', async () => {
    const { service, repo, baseInput } = await setup();

    const hanging = await service.beginRound({ ...baseInput, ownerId: 'hanging' });
    const stale = await service.beginRound({ ...baseInput, ownerId: 'stale' });
    const pendingRetry = await service.beginRound({ ...baseInput, ownerId: 'pending-retry' });

    const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    await repo.update({ id: hanging.attempt!.id }, { updatedAt: longAgo, status: 'waiting_claims', relayCompletedAt: longAgo });
    await repo.update({ id: stale.attempt!.id }, { updatedAt: longAgo, status: 'succeeded', completedAt: longAgo });
    await repo.update(
      { id: pendingRetry.attempt!.id },
      { updatedAt: longAgo, status: 'claim_timeout', completedAt: longAgo, nextRetryAt: new Date(Date.now() + 3_600_000) },
    );

    const result = await service.purgeStale({
      activeBefore: new Date(Date.now() - 3_600_000),
      terminalBefore: new Date(Date.now() - 24 * 3_600_000),
    });

    expect(result.converged).toBe(1);
    expect(result.deleted).toBe(1);
    const remaining = await repo.find();
    expect(remaining.map((row) => row.ownerId).sort()).toEqual(['hanging', 'pending-retry']);
    // 悬挂行被收敛为终态：已转发过的记认领超时
    expect(remaining.find((row) => row.ownerId === 'hanging')?.status).toBe('claim_timeout');
  });

  it('观测降级：写入失败只置标记并返回空结果，绝不向主链路抛错', async () => {
    const { service, baseInput } = await setup();
    const repo = (service as unknown as { repo: { save: () => Promise<unknown> } }).repo;
    const original = repo.save;
    repo.save = async () => {
      throw new Error('db is down');
    };
    try {
      const begin = await service.beginRound(baseInput);
      expect(begin.attempt).toBeNull();
      expect(service.getObservability().degraded).toBe(true);
      expect(service.getObservability().writeFailures).toBeGreaterThan(0);
    } finally {
      repo.save = original;
    }
  });
});

import { DataSource } from 'typeorm';
// 每个用例都会新建 SQLite 内存库并跑基线迁移；满负载串行执行时会超过 jest 默认 5s
jest.setTimeout(30_000);
import { TelegramAccountError } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramUserClientError } from '../telegram-user/telegram-user-client.service';
import { MirrorExecutionError, backoffMsFor, classifyMirrorError } from './telegram-mirror.errors';

const originalDbType = process.env.DB_TYPE;

async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toThrow();
  await promise.catch((error: { getStatus?: () => number; status?: number }) => {
    const actual = typeof error.getStatus === 'function' ? error.getStatus() : error.status;
    expect(actual).toBe(status);
  });
}

describe('TelegramMirrorTaskService（SQLite 内存库）', () => {
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
    const { TelegramMirrorTaskService } = require('./telegram-mirror-task.service') as typeof import('./telegram-mirror-task.service');
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

    const queue = {
      add: jest.fn(
        async (_name?: string, _data?: unknown, _opts?: Record<string, unknown>) => ({}),
      ),
      getJob: jest.fn(async (_jobId: string) => null as null | { getState: () => Promise<string>; remove: () => Promise<void> }),
    };
    const audit = { log: jest.fn() };
    const service = new TelegramMirrorTaskService(
      dataSource.getRepository(TelegramMirrorTaskEntity()),
      queue as never,
      audit as never,
    );
    /** 读取第 index 次入队的 job options（jobId/delay），避免 jest 元组的联合类型噪声 */
    const callOptions = (index: number): { jobId?: string; delay?: number } | undefined =>
      queue.add.mock.calls[index]?.[2] as { jobId?: string; delay?: number } | undefined;
    const findRetryOptions = (): { jobId?: string; delay?: number } | undefined =>
      queue.add.mock.calls
        .map((_call, index) => callOptions(index))
        .find((options) => String(options?.jobId ?? '').includes('#r1-'));
    return { service, queue, audit, callOptions, findRetryOptions, repo: dataSource.getRepository(TelegramMirrorTaskEntity()) };
  }

  function TelegramMirrorTaskEntity() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../common/entities/telegram-mirror-task.entity') as typeof import('../common/entities/telegram-mirror-task.entity')).TelegramMirrorTask;
  }

  const baseParams = {
    ruleId: 'rule-1',
    ownerType: 'file' as const,
    ownerId: 'file-1',
    sourceVersion: 1,
    mode: 'bot_upload' as const,
    sourceAccountId: '111111',
    sourceChatId: '-100111',
    sourceMessageId: '42',
  };

  it('建单：首次创建并入队，重复触发幂等复用同一条记录', async () => {
    const { service, queue, repo, callOptions } = await setup();
    const first = await service.enqueue(baseParams);
    expect(first.created).toBe(true);
    expect(first.task.status).toBe('queued');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(callOptions(0)?.jobId).toBe('rule-1:file:file-1:1');

    const second = await service.enqueue(baseParams);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(await repo.count()).toBe(1);
  });

  it('覆盖上传（版本递增）产生新任务，旧任务仍保留用于审计', async () => {
    const { service, repo } = await setup();
    await service.enqueue(baseParams);
    const bumped = await service.enqueue({ ...baseParams, sourceVersion: 2 });
    expect(bumped.created).toBe(true);
    expect(await repo.count()).toBe(2);
  });

  it('领取是原子的：只有第一次领取成功，重复投递直接返回', async () => {
    const { service } = await setup();
    const { task } = await service.enqueue(baseParams);

    const claimed = await service.claim(task.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);

    const second = await service.claim(task.id);
    expect(second).toBeNull();
  });

  it('状态流转：blocked / cancelled / failed / succeeded 互斥且可读回', async () => {
    const { service } = await setup();
    const { task } = await service.enqueue(baseParams);
    await service.claim(task.id);

    await service.markBlocked(task.id, 'target_permission_denied', '备份群无发帖权限');
    let current = await service.findById(task.id);
    expect(current?.status).toBe('blocked');
    expect(current?.lastErrorCode).toBe('target_permission_denied');

    await service.markSucceeded(task.id, {
      targetAccountId: '222222',
      targetChatId: '-100222',
      targetMessageId: '77',
      targetTelegramFileId: 'FILE-BACKUP',
      mode: 'bot_upload',
    });
    current = await service.findById(task.id);
    expect(current?.status).toBe('succeeded');
    expect(current?.targetMessageId).toBe('77');
    expect(current?.lastErrorCode).toBeNull();
  });

  it('重试退避：未超上限转 retrying 并重新入队；超上限转 failed', async () => {
    const { service, findRetryOptions } = await setup();
    const { task } = await service.enqueue(baseParams);
    await service.claim(task.id);

    const first = await service.markRetrying(task.id, {
      code: 'network_error',
      summary: 'socket hang up',
      delayMs: 1000,
      attempts: 1,
    });
    expect(first.exhausted).toBe(false);
    expect((await service.findById(task.id))?.status).toBe('retrying');

    const exhausted = await service.markRetrying(task.id, {
      code: 'network_error',
      summary: 'socket hang up',
      delayMs: 1000,
      attempts: 5,
    });
    expect(exhausted.exhausted).toBe(true);
    expect((await service.findById(task.id))?.status).toBe('failed');

    await service.scheduleRetry({ ...task, attempts: 1 }, 500);
    const retryOptions = findRetryOptions();
    expect(retryOptions).toBeDefined();
    expect(retryOptions?.delay).toBe(500);
  });

  it('回执保存与退回排队：不重复上传、开关关闭不丢任务', async () => {
    const { service } = await setup();
    const { task } = await service.enqueue(baseParams);
    await service.claim(task.id);

    await service.saveReceipt(task.id, {
      targetAccountId: '222222',
      targetChatId: '-100222',
      targetMessageId: '99',
      targetTelegramFileId: 'FILE-RECEIPT',
    });
    const withReceipt = await service.findById(task.id);
    expect(withReceipt?.receiptPending).toBe(true);
    expect(withReceipt?.targetTelegramFileId).toBe('FILE-RECEIPT');

    await service.returnToQueue(task.id, 'mirror_feature_disabled', '镜像功能已关闭');
    const requeued = await service.findById(task.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempts).toBe(0);
  });

  it('人工重试与取消：已完成不可重试、执行中不可取消', async () => {
    const { service, repo } = await setup();
    const { task } = await service.enqueue(baseParams);
    await service.claim(task.id);
    await service.markSucceeded(task.id, {
      targetAccountId: '222222',
      targetChatId: '-100222',
      targetMessageId: '1',
      targetTelegramFileId: 'F',
      mode: 'bot_upload',
    });
    await expectHttpStatus(service.retry(task.id, 'admin-1'), 400);

    const second = await service.enqueue({ ...baseParams, ownerId: 'file-2' });
    await service.claim(second.task.id);
    await expectHttpStatus(service.cancel(second.task.id, 'admin-1'), 400);

    const third = await service.enqueue({ ...baseParams, ownerId: 'file-3' });
    await service.markBlocked(third.task.id, 'rule_disabled', '规则未启用');
    const retried = await service.retry(third.task.id, 'admin-1');
    expect(retried.status).toBe('queued');
    const cancelled = await service.cancel(third.task.id, 'admin-1');
    expect(cancelled.status).toBe('cancelled');
    expect(await repo.count()).toBe(3);
  });

  it('重新入队前释放同 jobId 的终态 job（否则 Bull 静默丢弃，任务永远停在 queued）', async () => {
    const { service, queue, repo } = await setup();
    const { task } = await service.enqueue(baseParams);
    // 模拟该任务的首次 job 已完成并被保留在 completed 集合（Bull 对已存在 jobId 直接返回旧 job）
    const terminalJob = {
      getState: jest.fn(async () => 'completed'),
      remove: jest.fn(async () => undefined),
    };
    queue.getJob.mockResolvedValueOnce(terminalJob);

    await service.returnToQueue(task.id, 'mirror_feature_disabled', '镜像功能已关闭');
    const count = await service.reconcileQueued();

    expect(count).toBe(1);
    expect(terminalJob.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalled();
    expect((await repo.findOneByOrFail({ id: task.id })).status).toBe('queued');
  });

  it('重启恢复与对账：running 转 retrying、queued 重新入队', async () => {
    const { service, queue, repo } = await setup();
    const { task } = await service.enqueue(baseParams);
    await repo.update({ id: task.id }, { status: 'running' });

    const resumed = await service.resumeInterrupted();
    expect(resumed).toBe(1);
    expect((await service.findById(task.id))?.status).toBe('retrying');

    const reconcileCallsBefore = queue.add.mock.calls.length;
    await service.returnToQueue(task.id, 'mirror_feature_disabled', '关闭');
    const count = await service.reconcileQueued();
    expect(count).toBe(1);
    expect(queue.add.mock.calls.length).toBeGreaterThan(reconcileCallsBefore);
  });

  it('任务概览：按状态计数并给出最近错误', async () => {
    const { service } = await setup();
    const { task } = await service.enqueue(baseParams);
    await service.claim(task.id);
    await service.markBlocked(task.id, 'user_permission_denied', '用户账号无写权限');
    const { task: second } = await service.enqueue({ ...baseParams, ownerId: 'file-2' });
    await service.claim(second.id);
    await service.markSucceeded(second.id, {
      targetAccountId: '222222',
      targetChatId: '-100222',
      targetMessageId: '5',
      targetTelegramFileId: 'F2',
      mode: 'user_copy',
    });

    const summary = await service.summary();
    expect(summary.blocked).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.queued).toBe(0);
    expect(summary.lastError?.code).toBe('user_permission_denied');
  });

  it('错误分类：限流尊重 retry_after、权限与源失效阻塞、网络可重试', () => {
    expect(classifyMirrorError(new TelegramAccountError('Too Many Requests: retry after 30', '111111', 'flood', 429, 30)))
      .toMatchObject({ code: 'flood_wait', kind: 'retryable', retryAfterMs: 30_000 });

    expect(classifyMirrorError(new TelegramAccountError('Bad Request: file_id_invalid', '111111', 'unavailable', 400)))
      .toMatchObject({ code: 'source_file_unavailable', kind: 'blocked' });

    expect(classifyMirrorError(new TelegramAccountError('Not enough rights to send documents', '111111', 'other', 400)))
      .toMatchObject({ code: 'target_permission_denied', kind: 'blocked' });

    expect(classifyMirrorError(new TelegramAccountError('socket hang up', '111111', 'network')))
      .toMatchObject({ code: 'account_network', kind: 'retryable' });

    expect(classifyMirrorError(new TelegramUserClientError('SESSION_REVOKED', 'auth')))
      .toMatchObject({ code: 'user_session_invalid', kind: 'blocked' });

    expect(classifyMirrorError(new TelegramUserClientError('CHAT_WRITE_FORBIDDEN', 'permission')))
      .toMatchObject({ code: 'user_permission_denied', kind: 'blocked' });

    expect(classifyMirrorError(new MirrorExecutionError('source_message_unresolved', '缺少源消息定位', 'blocked')))
      .toMatchObject({ code: 'source_message_unresolved', kind: 'blocked' });

    // 未识别错误按可重试处理，由最大尝试次数兜底（不会无限重试）
    expect(classifyMirrorError(new Error('boom'))).toMatchObject({ code: 'unclassified_error', kind: 'retryable' });
  });

  it('退避为指数增长且不超过上限', () => {
    expect(backoffMsFor(1)).toBe(30_000);
    expect(backoffMsFor(2)).toBe(60_000);
    expect(backoffMsFor(3)).toBe(120_000);
    expect(backoffMsFor(20)).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});

import { DataSource } from 'typeorm';
// 每个用例都会新建 SQLite 内存库并跑基线迁移；满负载串行执行时会超过 jest 默认 5s
jest.setTimeout(30_000);
import { TelegramAccountError } from '../telegram-account-pool/telegram-account-client.service';

const originalDbType = process.env.DB_TYPE;

describe('TelegramMirrorProcessor（SQLite 内存库 + 伪执行器）', () => {
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

  interface Harness {
    processor: { handle: (job: unknown) => Promise<void> };
    tasks: {
      enqueue: (params: Record<string, unknown>) => Promise<{ task: { id: string }; created: boolean }>;
      findById: (id: string) => Promise<Record<string, unknown> | null>;
      scheduleRetry: (task: unknown, delay: number) => Promise<void>;
    };
    userCopy: { execute: jest.Mock };
    queue: { add: jest.Mock };
    metrics: { snapshot: () => Record<string, number> };
    files: { save: (entity: Record<string, unknown>) => Promise<Record<string, unknown>> };
  }

  async function setup(options: {
    rule?: Record<string, unknown> | null;
    mirrorEnabled?: boolean;
  } = {}): Promise<Harness> {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { databaseEntities } = require('../database/entities') as typeof import('../database/entities');
    const { SqliteEntitySchema1700000000000 } = require('../migrations/0000000000000-SqliteEntitySchema') as typeof import('../migrations/0000000000000-SqliteEntitySchema');
    const { TelegramMirrorTaskService } = require('./telegram-mirror-task.service') as typeof import('./telegram-mirror-task.service');
    const { TelegramMirrorProcessor } = require('./telegram-mirror.processor') as typeof import('./telegram-mirror.processor');
    const { TelegramMirrorMetricsService } = require('./telegram-mirror-metrics.service') as typeof import('./telegram-mirror-metrics.service');
    const { File } = require('../common/entities/file.entity') as typeof import('../common/entities/file.entity');
    const { TelegramMirrorTask } = require('../common/entities/telegram-mirror-task.entity') as typeof import('../common/entities/telegram-mirror-task.entity');
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
    // 本用例只验证镜像处理器逻辑，不需要构造完整用户体系：关闭外键以便插入最小 files 行
    await dataSource.query('PRAGMA foreign_keys = OFF');

    const queue = {
      add: jest.fn(async (_n?: string, _d?: unknown, _o?: unknown) => ({})),
      getJob: jest.fn(async (_jobId: string) => null),
    };
    const audit = { log: jest.fn() };
    const tasks = new TelegramMirrorTaskService(
      dataSource.getRepository(TelegramMirrorTask),
      queue as never,
      audit as never,
    );
    const rule = options.rule === undefined
      ? { id: 'rule-1', enabled: true, sourceChatId: '-100999', targetChatId: '-100222' }
      : options.rule;
    const config = { getRuleById: jest.fn(async () => rule) };
    const feature = { isMirrorEnabled: jest.fn(async () => options.mirrorEnabled ?? true) };
    // 唯一执行器：主群 → userbot → 镜像群（不存在 Bot 上传路径与降级路径）
    const userCopy = {
      execute: jest.fn(async () => ({
        targetAccountId: 'user-1',
        targetChatId: '-100222',
        targetMessageId: '99',
        targetTelegramFileId: '',
        fileSize: 1024,
        mode: 'user_copy' as const,
      })),
    };
    const metrics = new TelegramMirrorMetricsService();

    const processor = new TelegramMirrorProcessor(
      tasks as never,
      config as never,
      feature as never,
      userCopy as never,
      metrics as never,
      dataSource.getRepository(File),
    );

    return {
      processor: processor as never,
      tasks: tasks as never,
      userCopy,
      queue,
      metrics: metrics as never,
      files: dataSource.getRepository(File) as never,
    };
  }

  const enqueueParams = {
    ruleId: 'rule-1',
    ownerType: 'file' as const,
    ownerId: 'file-1',
    sourceVersion: 1,
    sourceAccountId: '111111',
    sourceChatId: '7001',
    sourceMessageId: '42',
  };

  async function seedFile(harness: Harness, uploadVersion = 1): Promise<void> {
    await harness.files.save({
      id: 'file-1',
      filename: 'doc.pdf',
      originalName: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      telegramFileId: 'FILE-PRIMARY',
      uploaderId: 'user-1',
      status: 'ready',
      uploadVersion,
      uploadStage: 'committed',
    });
  }

  function taskRepo() {
    const { TelegramMirrorTask } = require('../common/entities/telegram-mirror-task.entity') as typeof import('../common/entities/telegram-mirror-task.entity');
    return dataSource.getRepository(TelegramMirrorTask);
  }

  it('唯一链路成功：任务转 succeeded 并记录目标账号与消息（无 file_id 也确认成功）', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('succeeded');
    expect(saved?.targetAccountId).toBe('user-1');
    expect(saved?.targetMessageId).toBe('99');
    expect(saved?.mode).toBe('user_copy');
    expect(harness.metrics.snapshot().tasksSucceeded).toBe(1);
    expect(harness.metrics.snapshot().userCopyCount).toBe(1);
  });

  it('重复投递同一任务：第二次领取失败，不重复执行', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });
    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });

    expect(harness.userCopy.execute).toHaveBeenCalledTimes(1);
  });

  it('回执优先：转发成功但未落库时直接确认，不重复转发', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);
    await taskRepo().update({ id: task.id }, {
      status: 'retrying',
      receiptPending: true,
      targetAccountId: 'user-1',
      targetChatId: '-100222',
      targetMessageId: '77',
      // 用户账号转发路径没有 Bot 可用的 file_id，回执判据不能依赖它
      targetTelegramFileId: '',
    });

    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });

    expect(harness.userCopy.execute).not.toHaveBeenCalled();
    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('succeeded');
    expect(saved?.targetMessageId).toBe('77');
  });

  it('规则缺失或未启用：任务阻塞并给出可诊断原因', async () => {
    const missing = await setup({ rule: null });
    await seedFile(missing);
    const first = await missing.tasks.enqueue(enqueueParams);
    await missing.processor.handle({ data: { taskId: first.task.id } });
    expect((await missing.tasks.findById(first.task.id))?.status).toBe('blocked');
    expect(missing.userCopy.execute).not.toHaveBeenCalled();

    const disabled = await setup({ rule: { id: 'rule-1', enabled: false, sourceChatId: '-100999', targetChatId: '-100222' } });
    await seedFile(disabled);
    const second = await disabled.tasks.enqueue(enqueueParams);
    await disabled.processor.handle({ data: { taskId: second.task.id } });
    const blocked = await disabled.tasks.findById(second.task.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.lastErrorCode).toBe('rule_disabled');
  });

  it('镜像开关关闭：任务退回排队（不执行、不丢弃）', async () => {
    const harness = await setup({ mirrorEnabled: false });
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('queued');
    expect(saved?.lastErrorCode).toBe('mirror_feature_disabled');
    expect(harness.userCopy.execute).not.toHaveBeenCalled();
  });

  it('覆盖上传：版本不匹配的旧任务作废，不写入镜像群', async () => {
    const harness = await setup();
    await seedFile(harness, 2);
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('cancelled');
    expect(harness.userCopy.execute).not.toHaveBeenCalled();
  });

  it('权限类错误：任务阻塞且不会无限重试', async () => {
    const harness = await setup();
    await seedFile(harness);
    harness.userCopy.execute.mockRejectedValueOnce(
      new TelegramAccountError('Not enough rights to send documents to the chat', '1234567', 'other', 400),
    );
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('blocked');
    expect(saved?.lastErrorCode).toBe('target_permission_denied');
    expect(harness.metrics.snapshot().tasksBlocked).toBe(1);
  });

  it('网络类错误：任务转 retrying 并重新入队', async () => {
    const harness = await setup();
    await seedFile(harness);
    harness.userCopy.execute.mockRejectedValueOnce(new TelegramAccountError('socket hang up', '1234567', 'network'));
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('retrying');
    expect(harness.metrics.snapshot().tasksRetried).toBe(1);
    // 首次入队 + 重试入队
    expect(harness.queue.add.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('凭据失效：任务阻塞等待管理员重新授权（不降级为字节上传）', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { TelegramUserClientError } = require('../telegram-user/telegram-user-client.service') as typeof import('../telegram-user/telegram-user-client.service');
    harness.userCopy.execute.mockRejectedValueOnce(new TelegramUserClientError('SESSION_REVOKED', 'auth'));
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('blocked');
    expect(saved?.lastErrorCode).toBe('user_session_invalid');
  });

  it('回执未解析（unverified）：停在 blocked 且不再安排重试（重试会造成重复副本）', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { TelegramUserClientError } = require('../telegram-user/telegram-user-client.service') as typeof import('../telegram-user/telegram-user-client.service');
    harness.userCopy.execute.mockRejectedValueOnce(
      new TelegramUserClientError('转发请求已被服务端接受，但返回结果未包含目标消息 ID', 'unverified'),
    );
    const { task } = await harness.tasks.enqueue(enqueueParams);
    const queuedBefore = (harness.queue.add as jest.Mock).mock.calls.length;

    await harness.processor.handle({ data: { taskId: task.id } });

    expect((harness.queue.add as jest.Mock).mock.calls.length).toBe(queuedBefore);
    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('blocked');
    expect(saved?.lastErrorCode).toBe('user_copy_receipt_unresolved');
  });

  it('旧链路在途任务（mode=bot_upload）：显式阻塞并提示人工处理，不静默改写重跑', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);
    await taskRepo().update({ id: task.id }, { mode: 'bot_upload' });

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('blocked');
    expect(saved?.lastErrorCode).toBe('legacy_mode_retired');
    expect(harness.userCopy.execute).not.toHaveBeenCalled();
  });

  it('缺少 taskId 的 job 直接忽略（不产生副作用）', async () => {
    const harness = await setup();
    await harness.processor.handle({ data: {} });
    await harness.processor.handle({});
    expect(harness.userCopy.execute).not.toHaveBeenCalled();
  });
});

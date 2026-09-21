import { DataSource } from 'typeorm';
// 每个用例都会新建 SQLite 内存库并跑基线迁移；满负载串行执行时会超过 jest 默认 5s
jest.setTimeout(30_000);
import { TelegramAccountError } from '../telegram-account-pool/telegram-account-client.service';
import { MirrorExecutionError } from './telegram-mirror.errors';

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
    bot: { execute: jest.Mock };
    userCopy: { execute: jest.Mock; isUserPathViable: jest.Mock };
    accounts: { markDegraded: jest.Mock };
    audit: { log: jest.Mock };
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
      ? {
        id: 'rule-1',
        enabled: true,
        mode: 'bot_upload',
        fallbackMode: 'disabled',
        sourceChatId: '-100111',
        targetChatId: '-100222',
      }
      : options.rule;
    const config = { getRuleById: jest.fn(async () => rule) };
    const feature = { isMirrorEnabled: jest.fn(async () => options.mirrorEnabled ?? true) };
    const bot = {
      execute: jest.fn(async () => ({
        targetAccountId: '222222',
        targetChatId: '-100222',
        targetMessageId: '88',
        targetTelegramFileId: 'FILE-BACKUP',
        fileSize: 1024,
        mode: 'bot_upload' as const,
      })),
    };
    const userCopy = {
      execute: jest.fn(async () => ({
        targetAccountId: 'user-1',
        targetChatId: '-100222',
        targetMessageId: '99',
        targetTelegramFileId: '',
        fileSize: 1024,
        mode: 'user_copy' as const,
      })),
      isUserPathViable: jest.fn(async () => false),
    };
    const metrics = new TelegramMirrorMetricsService();
    const accounts = { markDegraded: jest.fn(async () => undefined) };

    const processor = new TelegramMirrorProcessor(
      tasks as never,
      config as never,
      feature as never,
      bot as never,
      userCopy as never,
      metrics as never,
      audit as never,
      dataSource.getRepository(File),
    );

    return {
      processor: processor as never,
      tasks: tasks as never,
      bot,
      userCopy,
      accounts,
      audit,
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
    mode: 'bot_upload' as const,
    sourceAccountId: '111111',
    sourceChatId: '-100111',
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

  it('Bot 路径成功：任务转 succeeded 并记录目标账号与消息', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('succeeded');
    expect(saved?.targetAccountId).toBe('222222');
    expect(saved?.targetTelegramFileId).toBe('FILE-BACKUP');
    expect(harness.metrics.snapshot().tasksSucceeded).toBe(1);
    expect(harness.metrics.snapshot().botUploadCount).toBe(1);
  });

  it('重复投递同一任务：第二次领取失败，不重复执行', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });
    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });

    expect(harness.bot.execute).toHaveBeenCalledTimes(1);
  });

  it('回执优先：上次上传成功但未落库时直接确认，不重复上传', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue(enqueueParams);
    const { TelegramMirrorTask } = require('../common/entities/telegram-mirror-task.entity') as typeof import('../common/entities/telegram-mirror-task.entity');
    await dataSource.getRepository(TelegramMirrorTask).update({ id: task.id }, {
      status: 'retrying',
      receiptPending: true,
      targetAccountId: '222222',
      targetChatId: '-100222',
      targetMessageId: '77',
      targetTelegramFileId: 'FILE-RECEIPT',
    });

    await harness.processor.handle({ data: { taskId: task.id, ruleId: 'rule-1' } });

    expect(harness.bot.execute).not.toHaveBeenCalled();
    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('succeeded');
    expect(saved?.targetTelegramFileId).toBe('FILE-RECEIPT');
  });

  it('规则缺失或未启用：任务阻塞并给出可诊断原因', async () => {
    const missing = await setup({ rule: null });
    await seedFile(missing);
    const first = await missing.tasks.enqueue(enqueueParams);
    await missing.processor.handle({ data: { taskId: first.task.id } });
    expect((await missing.tasks.findById(first.task.id))?.status).toBe('blocked');
    expect(missing.bot.execute).not.toHaveBeenCalled();

    const disabled = await setup({ rule: { id: 'rule-1', enabled: false, mode: 'bot_upload', fallbackMode: 'disabled', sourceChatId: '-100111', targetChatId: '-100222' } });
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
    expect(harness.bot.execute).not.toHaveBeenCalled();
  });

  it('覆盖上传：版本不匹配的旧任务作废，不写入备份群', async () => {
    const harness = await setup();
    await seedFile(harness, 2);
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('cancelled');
    expect(harness.bot.execute).not.toHaveBeenCalled();
  });

  it('权限类错误：任务阻塞且权限错误不会无限重试', async () => {
    const harness = await setup();
    await seedFile(harness);
    harness.bot.execute.mockRejectedValueOnce(
      new TelegramAccountError('Not enough rights to send documents to the chat', '222222', 'other', 400),
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
    harness.bot.execute.mockRejectedValueOnce(new TelegramAccountError('socket hang up', '222222', 'network'));
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('retrying');
    expect(harness.metrics.snapshot().tasksRetried).toBe(1);
    // 首次入队 + 重试入队
    expect(harness.queue.add.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('凭据失效：任务阻塞等待管理员重新授权（账号降级由执行器负责）', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { TelegramUserClientError } = require('../telegram-user/telegram-user-client.service') as typeof import('../telegram-user/telegram-user-client.service');
    harness.userCopy.isUserPathViable.mockResolvedValue(true);
    harness.userCopy.execute.mockRejectedValueOnce(new TelegramUserClientError('SESSION_REVOKED', 'auth'));
    const { task } = await harness.tasks.enqueue({ ...enqueueParams, mode: 'user_copy' });

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('blocked');
    expect(saved?.lastErrorCode).toBe('user_session_invalid');
  });

  it('用户复制回执（无 Bot file_id）：凭回执确认成功，不重复复制产生重复备份', async () => {
    const harness = await setup();
    await seedFile(harness);
    const { task } = await harness.tasks.enqueue({ ...enqueueParams, mode: 'user_copy' as never });
    const { TelegramMirrorTask } = require('../common/entities/telegram-mirror-task.entity') as typeof import('../common/entities/telegram-mirror-task.entity');
    await dataSource.getRepository(TelegramMirrorTask).update({ id: task.id }, {
      status: 'retrying',
      mode: 'user_copy',
      receiptPending: true,
      targetAccountId: 'user-row-1',
      targetChatId: '-100222',
      targetMessageId: '12345',
      // 用户无源复制没有 Bot 可用的 file_id，回执判据不能依赖它
      targetTelegramFileId: '',
    });

    await harness.processor.handle({ data: { taskId: task.id } });

    expect(harness.userCopy.execute).not.toHaveBeenCalled();
    expect(harness.bot.execute).not.toHaveBeenCalled();
    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('succeeded');
    expect(saved?.targetMessageId).toBe('12345');
  });

  it('账号客户端把 400 权限错误归为 unavailable 时仍判 blocked（不反复重传字节）', async () => {
    const harness = await setup();
    await seedFile(harness);
    harness.bot.execute.mockRejectedValueOnce(
      new TelegramAccountError(
        'Bad Request: not enough rights to send documents to the chat',
        '222222',
        'unavailable',
        400,
      ),
    );
    const { task } = await harness.tasks.enqueue(enqueueParams);

    await harness.processor.handle({ data: { taskId: task.id } });

    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('blocked');
    expect(saved?.lastErrorCode).toBe('target_permission_denied');
    expect(harness.metrics.snapshot().tasksBlocked).toBe(1);
  });

  it('显式降级：用户复制失败后按规则降级 Bot 上传，并写审计', async () => {
    const harness = await setup({
      rule: {
        id: 'rule-1',
        enabled: true,
        mode: 'auto',
        fallbackMode: 'bot_upload',
        sourceChatId: '-100111',
        targetChatId: '-100222',
      },
    });
    await seedFile(harness);
    harness.userCopy.isUserPathViable.mockResolvedValue(true);
    harness.userCopy.execute.mockRejectedValueOnce(new MirrorExecutionError('source_message_unresolved', '缺少源消息定位', 'blocked'));
    const { task } = await harness.tasks.enqueue({ ...enqueueParams, mode: 'auto' as never });

    await harness.processor.handle({ data: { taskId: task.id } });

    expect(harness.bot.execute).toHaveBeenCalledTimes(1);
    const saved = await harness.tasks.findById(task.id);
    expect(saved?.status).toBe('succeeded');
    expect(saved?.mode).toBe('bot_upload');
    expect(harness.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'telegram_mirror_fallback_applied' }));
    expect(harness.metrics.snapshot().fallbackCount).toBe(1);
  });

  it('缺少 taskId 的 job 直接忽略（不产生副作用）', async () => {
    const harness = await setup();
    await harness.processor.handle({ data: {} });
    await harness.processor.handle({});
    expect(harness.bot.execute).not.toHaveBeenCalled();
  });
});

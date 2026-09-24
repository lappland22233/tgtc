/**
 * 5c 回归：历史补偿四类分类（只分类，不做扩散）+ 批处理避免 N+1。
 *
 * 事故形态（本用例存在的理由）：
 * - 原实现逐文件 `tasks.count`（N+1），且只区分「已覆盖 / 将建单」：缺源锚点的文件会被
 *   当作「将建单」计入影响面，实际建单后必然阻塞在 source_message_unresolved；
 * - 覆盖上传后旧版本任务的存在也需要单独分类（将按当前版本补建），否则管理员无法从
 *   影响面里读出「版本不符」这一类；
 * - 分类只影响统计与跳过判定，绝不引入新的执行路径（扩散仍只由镜像任务队列承担）。
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { TelegramMirrorBackfillService } from './telegram-mirror-backfill.service';

function makeFile(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    size: 100,
    uploadVersion: 1,
    telegramChatId: '-100777',
    telegramMessageId: '55',
    telegramSourceAccountId: '777',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

interface SetupOptions {
  batch: Array<Record<string, unknown>>;
  /** 任务聚合原始行（跨方言 COUNT(*) 返回字符串） */
  taskRows?: Array<{ ownerId: string; sourceVersion: number | string; count: string }>;
  /** 每批的 ready 副本（ownerId → 行） */
  copies?: Map<string, Array<Record<string, unknown>>>;
}

function setup(options: SetupOptions) {
  const filesQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => options.batch),
  };
  const filesRepo = { createQueryBuilder: jest.fn(() => filesQb) };

  const tasksQb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(async () => options.taskRows ?? []),
  };
  const tasksRepo = {
    createQueryBuilder: jest.fn(() => tasksQb),
    /** 5c 后不再使用（逐文件 count 的 N+1 已移除）；保留 mock 以便断言零调用 */
    count: jest.fn(),
  };

  const config = {
    listEnabledRules: jest.fn(async () => [{ id: 'rule-1' }, { id: 'rule-2' }]),
  };
  const trigger = { onFileCommitted: jest.fn(async (..._args: unknown[]) => true) };
  const feature = { isMirrorEnabled: jest.fn(async () => true) };
  const audit = { log: jest.fn() };
  const fileCopies = { listReadyByOwnerIds: jest.fn(async () => options.copies ?? new Map()) };

  const service = new TelegramMirrorBackfillService(
    filesRepo as never,
    tasksRepo as never,
    config as never,
    trigger as never,
    feature as never,
    audit as never,
    fileCopies as never,
  );
  return { service, filesRepo, filesQb, tasksRepo, tasksQb, config, trigger, fileCopies };
}

/** 用假定时器推进批间 1s 睡眠，直到后台 run() 收敛（有界循环，防止测试悬挂） */
async function startAndWait(
  service: TelegramMirrorBackfillService,
  mode: 'dry-run' | 'apply',
  limit: number,
) {
  await service.start({ mode, limit }, 'admin-1');
  for (let i = 0; i < 5 && service.status().status === 'running'; i += 1) {
    await jest.advanceTimersByTimeAsync(1000);
  }
  return service.status();
}

describe('TelegramMirrorBackfillService（历史补偿四类分类）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('dry-run：一批文件分别落入 executable / missingAnchor / covered / staleVersion，计数与 queued/skipped 口径一致', async () => {
    const batch = [
      makeFile('f-exec'),                                                       // 锚点完整 → executable
      makeFile('f-missing', { telegramChatId: null, telegramMessageId: null }), // 无锚点 → missingAnchor
      makeFile('f-covered', { uploadVersion: 2 }),                              // 当前版本任务齐 → covered
      makeFile('f-stale', { uploadVersion: 3 }),                                // 只有旧版本任务 → staleVersion
    ];
    const ctx = setup({
      batch,
      taskRows: [
        { ownerId: 'f-covered', sourceVersion: 2, count: '2' },
        { ownerId: 'f-stale', sourceVersion: 1, count: '1' },
      ],
    });

    const job = await startAndWait(ctx.service, 'dry-run', 4);

    expect(job.status).toBe('completed');
    expect(job.scanned).toBe(4);
    expect(job.classification).toEqual({ executable: 1, missingAnchor: 1, covered: 1, staleVersion: 1 });
    expect(job.missingAnchorSample).toEqual(['f-missing']);
    // queued = 将建单数（executable + staleVersion）；skipped = covered + missingAnchor
    expect(job.queued).toBe(2);
    expect(job.skipped).toBe(2);
    expect(job.sample).toEqual(['f-exec', 'f-stale']);
    // dry-run 绝不建单
    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
  });

  it('apply：missingAnchor 不建单；executable / staleVersion 建单（副本锚点与账号随单传递）', async () => {
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const batch = [
      makeFile('f-exec'),
      makeFile('f-missing', { telegramChatId: null, telegramMessageId: null }),
      makeFile('f-stale', { uploadVersion: 2 }),
      makeFile('f-copy-anchor', { telegramChatId: null, telegramMessageId: null }),
    ];
    const ctx = setup({
      batch,
      taskRows: [{ ownerId: 'f-stale', sourceVersion: 1, count: '1' }],
      copies: new Map([
        ['f-copy-anchor', [{ accountId: '999', chatId: '-100999', messageId: '77', fileSize: '100' }]],
      ]),
    });

    const job = await startAndWait(ctx.service, 'apply', 4);

    expect(job.status).toBe('completed');
    expect(job.classification).toEqual({ executable: 2, missingAnchor: 1, covered: 0, staleVersion: 1 });
    // missingAnchor 不建单：只有 executable 与 staleVersion 产生 onFileCommitted
    const calledOwners = ctx.trigger.onFileCommitted.mock.calls.map(
      (call) => (call[0] as { ownerId: string }).ownerId,
    );
    expect(calledOwners).toEqual(['f-exec', 'f-stale', 'f-copy-anchor']);
    // 主记录锚点完整：源定位取主记录事实
    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'f-exec',
        sourceVersion: 1,
        sourceAccountId: '777',
        sourceChatId: '-100777',
        sourceMessageId: '55',
      }),
      'web_upload',
    );
    // 旧版本任务 → 按当前版本补建
    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'f-stale', sourceVersion: 2 }),
      'web_upload',
    );
    // 主记录缺锚点但副本可用：用副本的 chatId/messageId/accountId（与 5b 口径一致）
    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'f-copy-anchor',
        sourceAccountId: '999',
        sourceChatId: '-100999',
        sourceMessageId: '77',
      }),
      'web_upload',
    );
    expect(job.queued).toBe(3);
    expect(job.skipped).toBe(1);
    // missingAnchor 只记 debug（原因说明），不得 warn 刷屏
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('源锚点不可定位'));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('批处理只查一次副本表与一次任务聚合（守住「避免 N+1」）', async () => {
    const batch = [
      makeFile('f-1'),
      makeFile('f-2'),
      makeFile('f-3'),
      makeFile('f-4'),
      makeFile('f-5'),
    ];
    const ctx = setup({ batch });

    const job = await startAndWait(ctx.service, 'dry-run', 5);

    expect(job.status).toBe('completed');
    // 一批 5 个文件：副本查询与任务聚合都只允许一次（逐文件查询会变成 5 次）
    expect(ctx.fileCopies.listReadyByOwnerIds).toHaveBeenCalledTimes(1);
    expect(ctx.fileCopies.listReadyByOwnerIds).toHaveBeenCalledWith(
      'file',
      ['f-1', 'f-2', 'f-3', 'f-4', 'f-5'],
    );
    expect(ctx.tasksRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    // 旧实现逐文件 tasks.count 已移除
    expect(ctx.tasksRepo.count).not.toHaveBeenCalled();
    expect(ctx.filesRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
  });
});

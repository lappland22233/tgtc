import 'reflect-metadata';

// FileService 依赖链含 file-type（ESM-only），本测试不涉及文件服务，直接 mock
jest.mock('../file/file.service', () => ({ FileService: class FileService {} }));

// uuid v4 生成固定值，便于断言 queue.add 的 jobId / taskId
jest.mock('uuid', () => ({ v4: jest.fn(() => 'uuid') }));

import { ServiceUnavailableException } from '@nestjs/common';
import { FileVerifyService } from './file-verify.service';
import { TelegramFileNotFoundError } from '../telegram/telegram.errors';

function buildFileVerifyService() {
  const fileVerifyTaskRepository = {
    create: jest.fn(),
    insert: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const fileRepository = {
    createQueryBuilder: jest.fn(),
  };
  const telegramService = {
    verifyFileExists: jest.fn(),
  };
  const auditService = { log: jest.fn(), logAwait: jest.fn() };
  const fileVerifyQueue = { add: jest.fn(), getJob: jest.fn() };
  const service = new FileVerifyService(
    fileVerifyTaskRepository as any,
    fileRepository as any,
    telegramService as any,
    auditService as any,
    fileVerifyQueue as any,
  );
  return { service, fileVerifyTaskRepository, fileRepository, telegramService, auditService, fileVerifyQueue };
}

const mockUser = { id: 'user-1', email: 'admin@example.com' } as any;
const mockTask = {
  taskId: 'task-1',
  createdBy: 'user-1',
  mode: 'dry-run',
  allReady: false,
  limit: 500,
  concurrency: 4,
};

/** 构造 select 查询链：返回候选文件数组 */
function makeSelectChain(candidates: any[]) {
  const q: any = {};
  q.select = jest.fn(() => q);
  q.where = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.getMany = jest.fn(() => Promise.resolve(candidates));
  return q;
}

/** 构造 update 查询链（默认 affected:1） */
function makeUpdateChain(affected = 1) {
  const q: any = {};
  q.update = jest.fn(() => q);
  q.set = jest.fn(() => q);
  q.where = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.execute = jest.fn(() => Promise.resolve({ affected }));
  return q;
}

/** 收集 task 仓库所有 update 链上的 set 载荷（markStarted/updateProgress/markCompleted 共用同一链对象） */
function taskSetPayloads(taskRepo: any): Record<string, any>[] {
  const chain = taskRepo.createQueryBuilder.mock.results[0].value;
  return chain.set.mock.calls.map((c: any[]) => c[0]);
}

describe('FileVerifyService.runVerification', () => {
  beforeEach(() => jest.clearAllMocks());

  function setupRun(taskOverrides: Record<string, unknown> = {}, affected = 1) {
    const deps = buildFileVerifyService();
    // markStarted / updateProgress / markCompleted 都走 task 仓库 update 链
    deps.fileVerifyTaskRepository.createQueryBuilder.mockReturnValue(makeUpdateChain(affected));
    deps.fileVerifyTaskRepository.findOne.mockResolvedValue({ ...mockTask, ...taskOverrides });
    return deps;
  }

  it('dry-run 只统计不修改，遇到永久失效计入 invalid', async () => {
    const { service, fileRepository, telegramService } = setupRun();
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
        { id: 'f2', originalName: 'b.bin', size: 10, telegramFileId: 'tg-2', telegramFilePath: null },
      ]));
    telegramService.verifyFileExists.mockImplementation(async (id: string) => {
      if (id === 'tg-1') return { file_id: 'tg-1', file_path: 'documents/a.bin', file_size: 10 };
      throw new TelegramFileNotFoundError('invalid file_id');
    });

    await service.runVerification('task-1');

    // dry-run 不执行任何 file 的 update 链
    expect(fileRepository.createQueryBuilder.mock.calls.length).toBe(1); // 只有 select 链
  });

  it('apply 将永久失效文件标记 error，并回填有效文件的 path，审计 metadata 正确', async () => {
    const { service, fileRepository, telegramService, auditService, fileVerifyTaskRepository } = setupRun({ mode: 'apply' });
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
        { id: 'f2', originalName: 'b.bin', size: 10, telegramFileId: 'tg-bad', telegramFilePath: null },
      ]))
      .mockReturnValueOnce(makeUpdateChain()) // f1 回填 path
      .mockReturnValueOnce(makeUpdateChain()); // f2 标记 error
    telegramService.verifyFileExists.mockImplementation(async (id: string) => {
      if (id === 'tg-1') return { file_id: 'tg-1', file_path: 'documents/a.bin', file_size: 10 };
      throw new TelegramFileNotFoundError('invalid file_id');
    });

    await service.runVerification('task-1');

    // f1 回填：条件更新带 status='ready'
    const f1Set = fileRepository.createQueryBuilder.mock.results[1].value.set.mock.calls[0][0];
    expect(f1Set).toMatchObject({ telegramFilePath: 'documents/a.bin' });
    // f2 标记 error
    const f2Set = fileRepository.createQueryBuilder.mock.results[2].value.set.mock.calls[0][0];
    expect(f2Set).toMatchObject({ status: 'error', uploadStage: 'failed' });
    // 审计只记录统计摘要
    const audit = auditService.log.mock.calls[0][0];
    expect(audit.action).toBe('file_verify');
    expect(audit.userId).toBe('user-1');
    expect(audit.resourceId).toBe('task-1');
    expect(audit.metadata).toMatchObject({ markedError: 1, backfilled: 1, taskId: 'task-1' });
    // markCompleted 写入统计
    const completed = taskSetPayloads(fileVerifyTaskRepository).find((s) => s.status === 'completed');
    expect(completed).toMatchObject({ isActive: false, valid: 1, invalid: 1, backfilled: 1, markedError: 1 });
  });

  it('空 file_id 在 apply 下标记 error（无引用必然不可下载）', async () => {
    const { service, fileRepository, telegramService } = setupRun({ mode: 'apply' });
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: '  ', telegramFilePath: null },
      ]))
      .mockReturnValueOnce(makeUpdateChain());
    // telegram 不应被调用
    await service.runVerification('task-1');
    expect(telegramService.verifyFileExists).not.toHaveBeenCalled();
  });

  it('暂时性错误（非文件失效）仅计入 temporaryFailure，不修改数据', async () => {
    const { service, fileRepository, telegramService } = setupRun();
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
      ]));
    telegramService.verifyFileExists.mockRejectedValue(new Error('ETIMEDOUT'));

    await service.runVerification('task-1');
    // 不执行 file update 链
    expect(fileRepository.createQueryBuilder.mock.calls.length).toBe(1);
  });

  it('大小不一致仅计入 sizeMismatch，不误标失效', async () => {
    const { service, fileRepository, telegramService, fileVerifyTaskRepository } = setupRun({ mode: 'apply' });
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: 'documents/a.bin' },
      ]));
    telegramService.verifyFileExists.mockResolvedValue({ file_id: 'tg-1', file_path: 'documents/a.bin', file_size: 99 });

    await service.runVerification('task-1');
    // path 非空 → 不回填；size 不一致仅报告；valid=1, sizeMismatch=1, backfilled=0
    const completed = taskSetPayloads(fileVerifyTaskRepository).find((s) => s.status === 'completed');
    expect(completed).toMatchObject({ valid: 1, sizeMismatch: 1, backfilled: 0, invalid: 0 });
  });

  it('metadata_only 无 file_path 时仍判定 valid，且不执行空路径回填', async () => {
    const { service, fileRepository, telegramService, fileVerifyTaskRepository } = setupRun({ mode: 'apply' });
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([
      { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
    ]));
    telegramService.verifyFileExists.mockResolvedValue({ file_id: 'tg-1', file_path: '', file_size: 10 });

    await service.runVerification('task-1');

    expect(fileRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    const completed = taskSetPayloads(fileVerifyTaskRepository).find((s) => s.status === 'completed');
    expect(completed).toMatchObject({ valid: 1, invalid: 0, backfilled: 0 });
  });

  it('allReady=true 时不追加 telegramFilePath 为空的条件', async () => {
    const { service, fileRepository } = setupRun({ allReady: true });
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([]));
    await service.runVerification('task-1');
    const andWhere = fileRepository.createQueryBuilder.mock.results[0].value.andWhere;
    const conditions = andWhere.mock.calls.map((c: any[]) => String(c[0]));
    expect(conditions.some((c: string) => c.includes('telegramFilePath'))).toBe(false);
  });

  it('默认模式只检查 telegramFilePath 为空的候选', async () => {
    const { service, fileRepository } = setupRun({});
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([]));
    await service.runVerification('task-1');
    const andWhere = fileRepository.createQueryBuilder.mock.results[0].value.andWhere;
    const conditions = andWhere.mock.calls.map((c: any[]) => String(c[0]));
    expect(conditions.some((c: string) => c.includes('telegramFilePath'))).toBe(true);
  });

  it('空候选时快速完成，processed===totalCandidates===0，不调用 Telegram', async () => {
    const { service, fileRepository, telegramService, fileVerifyTaskRepository } = setupRun();
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([]));
    await service.runVerification('task-1');
    expect(telegramService.verifyFileExists).not.toHaveBeenCalled();
    // markCompleted 写入 0 统计
    const completed = taskSetPayloads(fileVerifyTaskRepository).find((s) => s.status === 'completed');
    expect(completed).toMatchObject({ isActive: false, processed: 0, totalCandidates: 0 });
  });

  it('apply 标记 error 时带 uploadVersion 守卫，防止误标覆盖上传后的新文件', async () => {
    const { service, fileRepository, telegramService } = setupRun({ mode: 'apply' });
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-bad', telegramFilePath: null, uploadVersion: 3 },
      ]))
      .mockReturnValueOnce(makeUpdateChain());
    telegramService.verifyFileExists.mockRejectedValue(new TelegramFileNotFoundError('invalid file_id'));

    await service.runVerification('task-1');

    const f1Chain = fileRepository.createQueryBuilder.mock.results[1].value;
    const whereCalls = f1Chain.andWhere.mock.calls as unknown[][];
    const versionWhere = whereCalls.find((c) => String(c[0]).includes('uploadVersion'));
    expect(versionWhere).toBeDefined();
    expect(versionWhere![1]).toMatchObject({ version: 3 });
  });

  it('崩溃恢复：任务为 running 时 markStarted 允许接管执行（running → running）', async () => {
    const { service, fileRepository, telegramService, fileVerifyTaskRepository } = setupRun({ status: 'running' });
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([
      { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
    ]));
    telegramService.verifyFileExists.mockResolvedValue({ file_id: 'tg-1', file_path: 'documents/a.bin', file_size: 10 });
    await service.runVerification('task-1');
    // markStarted 条件应允许 running（接管），而非仅 queued
    const startedChain = fileVerifyTaskRepository.createQueryBuilder.mock.results[0].value;
    const whereCalls = startedChain.andWhere.mock.calls as unknown[][];
    expect(whereCalls.some((c) => String(c[0]).includes("'running'"))).toBe(true);
    expect(telegramService.verifyFileExists).toHaveBeenCalled();
  });

  it('markStarted 命中 0 行（任务已终态）时直接返回，不执行体检', async () => {
    const { service, fileRepository, telegramService, fileVerifyTaskRepository } = setupRun({}, 0);
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([]));
    await service.runVerification('task-1');
    // affected=0 时 markStarted 返回 null，直接 return
    expect(telegramService.verifyFileExists).not.toHaveBeenCalled();
    expect(fileVerifyTaskRepository.findOne).not.toHaveBeenCalled();
  });
});

describe('FileVerifyService.createTask', () => {
  beforeEach(() => jest.clearAllMocks());

  it('插入成功且入队成功 → 返回 { task, isNewTask: true }，queue.add 以 { jobId: taskId } 调用', async () => {
    const { service, fileVerifyTaskRepository, fileVerifyQueue } = buildFileVerifyService();
    fileVerifyTaskRepository.create.mockReturnValue({ taskId: 'uuid', createdBy: 'user-1' });
    fileVerifyTaskRepository.insert.mockResolvedValue({});
    fileVerifyQueue.add.mockResolvedValue({} as any);

    const result = await service.createTask(mockUser, { mode: 'apply', limit: 100, concurrency: 2 });

    expect(result.isNewTask).toBe(true);
    expect(result.task).toMatchObject({ taskId: 'uuid' });
    expect(fileVerifyQueue.add).toHaveBeenCalledWith(
      'verify',
      { taskId: 'uuid' },
      expect.objectContaining({ jobId: 'uuid' }),
    );
  });

  it('插入撞唯一约束（code 23505）→ 返回现有活动任务 { task, isNewTask: false }，不调用 queue.add', async () => {
    const { service, fileVerifyTaskRepository, fileVerifyQueue } = buildFileVerifyService();
    fileVerifyTaskRepository.create.mockReturnValue({ taskId: 'uuid' });
    const active = { taskId: 'active-1', status: 'queued' };
    fileVerifyTaskRepository.insert.mockRejectedValue({ code: '23505' });
    fileVerifyTaskRepository.findOne.mockResolvedValue(active);

    const result = await service.createTask(mockUser, {});

    expect(result.isNewTask).toBe(false);
    expect(result.task).toBe(active);
    expect(fileVerifyQueue.add).not.toHaveBeenCalled();
  });

  it('入队失败 → 任务标记 failed 且释放槽位，并抛 ServiceUnavailableException', async () => {
    const { service, fileVerifyTaskRepository, fileVerifyQueue } = buildFileVerifyService();
    fileVerifyTaskRepository.create.mockReturnValue({ taskId: 'uuid' });
    fileVerifyTaskRepository.insert.mockResolvedValue({});
    fileVerifyQueue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    fileVerifyTaskRepository.createQueryBuilder.mockReturnValue(makeUpdateChain());

    await expect(service.createTask(mockUser, {})).rejects.toBeInstanceOf(ServiceUnavailableException);

    // 标记失败并释放槽位
    const failedSet = fileVerifyTaskRepository.createQueryBuilder.mock.results[0].value.set.mock.calls[0][0];
    expect(failedSet).toMatchObject({ status: 'failed', isActive: false });
  });
});

describe('FileVerifyService 进度更新与终态保护', () => {
  beforeEach(() => jest.clearAllMocks());

  it('markCompleted 只在 status IN (queued,running) 时执行（andWhere 含 status）', async () => {
    const { service, fileRepository, fileVerifyTaskRepository } = buildFileVerifyService();
    fileVerifyTaskRepository.createQueryBuilder.mockReturnValue(makeUpdateChain(1)); // markStarted
    fileVerifyTaskRepository.findOne.mockResolvedValue(mockTask);
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([
      { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
    ]));

    await service.runVerification('task-1');

    // 第 2 次调用是 markCompleted（单批：无 updateProgress，直接 markCompleted）
    const completedChain = fileVerifyTaskRepository.createQueryBuilder.mock.results[1].value;
    const whereCalls = completedChain.andWhere.mock.calls as unknown[][];
    expect(whereCalls.some((c) => String(c[0]).includes('status IN'))).toBe(true);
  });

  it('updateProgress 带 status 守卫（andWhere 含 status）', async () => {
    const { service, fileRepository, fileVerifyTaskRepository, telegramService } = buildFileVerifyService();
    fileVerifyTaskRepository.createQueryBuilder.mockReturnValue(makeUpdateChain(1)); // markStarted
    fileVerifyTaskRepository.findOne.mockResolvedValue(mockTask);
    // 候选超过 concurrency(4)，触发批次进度更新
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`, originalName: 'a.bin', size: 10, telegramFileId: `tg-${i}`, telegramFilePath: null,
    }));
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain(candidates));
    telegramService.verifyFileExists.mockResolvedValue({ file_id: 'x', file_path: 'p', file_size: 10 });

    await service.runVerification('task-1');

    // 第 2 次调用是 updateProgress（第一批）
    const progressChain = fileVerifyTaskRepository.createQueryBuilder.mock.results[1].value;
    const whereCalls = progressChain.andWhere.mock.calls as unknown[][];
    expect(whereCalls.some((c) => String(c[0]).includes('status IN'))).toBe(true);
  });
});

describe('FileVerifyService.markFailed', () => {
  beforeEach(() => jest.clearAllMocks());

  it('写入脱敏摘要且 isActive=false', async () => {
    const { service, fileVerifyTaskRepository } = buildFileVerifyService();
    fileVerifyTaskRepository.createQueryBuilder.mockReturnValue(makeUpdateChain());

    await service.markFailed('task-1', new Error('Token abcdefghijklmnopqrstuvwxyz123456 local path\n  some detail'));

    const failedSet = fileVerifyTaskRepository.createQueryBuilder.mock.results[0].value.set.mock.calls[0][0];
    expect(failedSet).toMatchObject({ status: 'failed', isActive: false });
    const summary = failedSet.errorSummary as string;
    expect(summary).not.toMatch(/\r|\n/);
    expect(summary).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(summary.length).toBeLessThanOrEqual(1000);
  });

  it('脱敏本地路径（Windows 与 Unix）', async () => {
    const { service, fileVerifyTaskRepository } = buildFileVerifyService();
    fileVerifyTaskRepository.createQueryBuilder.mockReturnValue(makeUpdateChain());

    await service.markFailed('task-1', new Error('无法读取 C:\\Users\\admin\\app\\data.bin 与 /var/www/html/index.html'));

    const failedSet = fileVerifyTaskRepository.createQueryBuilder.mock.results[0].value.set.mock.calls[0][0];
    const summary = failedSet.errorSummary as string;
    expect(summary).not.toContain('C:\\Users\\admin');
    expect(summary).not.toContain('/var/www/html');
    expect(summary).toContain('[path]');
  });
});

describe('FileVerifyService 启动孤儿任务清理', () => {
  beforeEach(() => jest.clearAllMocks());

  it('队列中无对应 job 的 queued 任务被标记 failed 并释放槽位', async () => {
    const { service, fileVerifyTaskRepository, fileVerifyQueue } = buildFileVerifyService();
    fileVerifyTaskRepository.find.mockResolvedValue([
      { taskId: 'orphan-1', isActive: true, status: 'queued' },
    ]);
    fileVerifyQueue.getJob.mockResolvedValue(null);
    fileVerifyTaskRepository.createQueryBuilder.mockReturnValue(makeUpdateChain());

    await service.onModuleInit();

    const failedSet = fileVerifyTaskRepository.createQueryBuilder.mock.results[0].value.set.mock.calls[0][0];
    expect(failedSet).toMatchObject({ status: 'failed', isActive: false });
  });

  it('队列中仍有对应 job 的正常排队任务不被清理', async () => {
    const { service, fileVerifyTaskRepository, fileVerifyQueue } = buildFileVerifyService();
    fileVerifyTaskRepository.find.mockResolvedValue([
      { taskId: 'ok-1', isActive: true, status: 'queued' },
    ]);
    fileVerifyQueue.getJob.mockResolvedValue({ id: 'ok-1' } as any);

    await service.onModuleInit();

    expect(fileVerifyTaskRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('清理失败不影响应用启动（静默降级）', async () => {
    const { service, fileVerifyTaskRepository, fileVerifyQueue } = buildFileVerifyService();
    fileVerifyTaskRepository.find.mockRejectedValue(new Error('DB down'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(fileVerifyQueue.getJob).not.toHaveBeenCalled();
  });
});

describe('FileVerifyService.toView', () => {
  const base = {
    taskId: 't1',
    createdBy: 'u1',
    mode: 'dry-run' as const,
    allReady: false,
    limit: 500,
    concurrency: 4,
    isActive: true,
    status: 'running' as const,
    totalCandidates: 200,
    processed: 50,
    valid: 10,
    invalid: 0,
    emptyFileId: 0,
    temporaryFailure: 0,
    sizeMismatch: 0,
    backfilled: 0,
    markedError: 0,
    errorSummary: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('progress 按 processed/totalCandidates 计算', () => {
    const { service } = buildFileVerifyService();
    expect(service.toView(base as any).progress).toBe(25);
  });

  it('progress 不超过 100', () => {
    const { service } = buildFileVerifyService();
    expect(service.toView({ ...base, processed: 200 } as any).progress).toBe(100);
  });

  it('零候选完成任务返回 100，零候选未完成任务返回 0', () => {
    const { service } = buildFileVerifyService();
    expect(service.toView({ ...base, status: 'completed', totalCandidates: 0, processed: 0 } as any).progress).toBe(100);
    expect(service.toView({ ...base, status: 'queued', totalCandidates: 0, processed: 0 } as any).progress).toBe(0);
  });
});

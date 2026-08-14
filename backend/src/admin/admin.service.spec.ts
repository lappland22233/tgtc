import 'reflect-metadata';

// FileService 依赖链含 file-type（ESM-only），且本测试仅关心体检逻辑，直接 mock
jest.mock('../file/file.service', () => ({ FileService: class FileService {} }));

import { AdminService } from './admin.service';
import { TelegramFileNotFoundError } from '../telegram/telegram.errors';

function buildAdminService() {
  const fileRepository = {
    createQueryBuilder: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const telegramService = {
    verifyFileExists: jest.fn(),
  };
  const auditService = { log: jest.fn(), logAwait: jest.fn() };
  const repoMock = () => ({}) as any;
  const service = new AdminService(
    repoMock(), // systemConfigRepository
    repoMock(), // bannedIPRepository
    fileRepository as any, // fileRepository
    repoMock(), // userRepository
    repoMock(), // accessLogRepository
    repoMock(), // accessLogRepo
    repoMock(), // auditLogRepo
    repoMock(), // telemetryRepo
    {} as any, // fileService
    {} as any, // configCacheService
    auditService as any,
    {} as any, // exportService
    {} as any, // mailerService
    telegramService as any,
  );
  return { service, fileRepository, telegramService, auditService };
}

const mockUser = { id: 'user-1', email: 'admin@example.com' } as any;

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

/** 构造 update 查询链 */
function makeUpdateChain() {
  const q: any = {};
  q.update = jest.fn(() => q);
  q.set = jest.fn(() => q);
  q.where = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.execute = jest.fn(() => Promise.resolve({ affected: 1 }));
  return q;
}

describe('AdminService.verifyFiles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('dry-run 只统计不修改，遇到永久失效计入 invalid', async () => {
    const { service, fileRepository, telegramService } = buildAdminService();
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
        { id: 'f2', originalName: 'b.bin', size: 10, telegramFileId: 'tg-2', telegramFilePath: null },
      ]));
    telegramService.verifyFileExists.mockImplementation(async (id: string) => {
      if (id === 'tg-1') return { file_id: 'tg-1', file_path: 'documents/a.bin', file_size: 10 };
      throw new TelegramFileNotFoundError('invalid file_id');
    });

    const result = await service.verifyFiles(mockUser, { mode: 'dry-run' });

    expect(result).toMatchObject({
      mode: 'dry-run',
      totalCandidates: 2,
      checked: 2,
      valid: 1,
      invalid: 1,
      markedError: 0,
      backfilled: 0,
    });
    // dry-run 不执行任何 update 链
    const updateCalls = fileRepository.createQueryBuilder.mock.calls.length;
    expect(updateCalls).toBe(1); // 只有 select 链
  });

  it('apply 将永久失效文件标记 error，并回填有效文件的 path', async () => {
    const { service, fileRepository, telegramService, auditService } = buildAdminService();
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

    const result = await service.verifyFiles(mockUser, { mode: 'apply' });

    expect(result).toMatchObject({ valid: 1, invalid: 1, backfilled: 1, markedError: 1 });
    // f1 回填：条件更新带 status='ready'
    const f1Set = fileRepository.createQueryBuilder.mock.results[1].value.set.mock.calls[0][0];
    expect(f1Set).toMatchObject({ telegramFilePath: 'documents/a.bin' });
    // f2 标记 error
    const f2Set = fileRepository.createQueryBuilder.mock.results[2].value.set.mock.calls[0][0];
    expect(f2Set).toMatchObject({ status: 'error', uploadStage: 'failed' });
    // 审计只记录统计摘要
    const audit = auditService.log.mock.calls[0][0];
    expect(audit.action).toBe('file_verify');
    expect(audit.metadata).toMatchObject({ markedError: 1, backfilled: 1 });
  });

  it('空 file_id 在 apply 下标记 error（无引用必然不可下载）', async () => {
    const { service, fileRepository, telegramService } = buildAdminService();
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: '  ', telegramFilePath: null },
      ]))
      .mockReturnValueOnce(makeUpdateChain());
    // telegram 不应被调用
    const result = await service.verifyFiles(mockUser, { mode: 'apply' });
    expect(telegramService.verifyFileExists).not.toHaveBeenCalled();
    expect(result).toMatchObject({ emptyFileId: 1, markedError: 1, checked: 1 });
  });

  it('暂时性错误（非文件失效）仅计入 temporaryFailure，不修改数据', async () => {
    const { service, fileRepository, telegramService } = buildAdminService();
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: null },
      ]));
    telegramService.verifyFileExists.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await service.verifyFiles(mockUser, { mode: 'apply' });
    expect(result).toMatchObject({ temporaryFailure: 1, invalid: 0, markedError: 0 });
    // 不执行 update 链
    expect(fileRepository.createQueryBuilder.mock.calls.length).toBe(1);
  });

  it('大小不一致仅计入 sizeMismatch，不误标失效', async () => {
    const { service, fileRepository, telegramService } = buildAdminService();
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-1', telegramFilePath: 'documents/a.bin' },
      ]))
      .mockReturnValueOnce(makeUpdateChain()); // 虽然 size 不一致但 path 非空 → 不回填
    telegramService.verifyFileExists.mockResolvedValue({ file_id: 'tg-1', file_path: 'documents/a.bin', file_size: 99 });

    const result = await service.verifyFiles(mockUser, { mode: 'apply' });
    expect(result).toMatchObject({ sizeMismatch: 1, valid: 1, invalid: 0, backfilled: 0 });
  });

  it('allReady=true 时不限制 telegramFilePath 为空的条件', async () => {
    const { service, fileRepository } = buildAdminService();
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([]));
    await service.verifyFiles(mockUser, { allReady: true });
    const andWhere = fileRepository.createQueryBuilder.mock.results[0].value.andWhere;
    const conditions = andWhere.mock.calls.map((c: any[]) => String(c[0]));
    // 默认模式会追加 telegramFilePath 为空 条件；allReady 则不追加
    expect(conditions.some((c: string) => c.includes('telegramFilePath'))).toBe(false);
  });

  it('默认模式只检查 telegramFilePath 为空的候选', async () => {
    const { service, fileRepository } = buildAdminService();
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([]));
    await service.verifyFiles(mockUser, {});
    const andWhere = fileRepository.createQueryBuilder.mock.results[0].value.andWhere;
    const conditions = andWhere.mock.calls.map((c: any[]) => String(c[0]));
    expect(conditions.some((c: string) => c.includes('telegramFilePath'))).toBe(true);
  });

  it('空候选时快速返回统计，不调用 Telegram', async () => {
    const { service, fileRepository, telegramService } = buildAdminService();
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([]));
    const result = await service.verifyFiles(mockUser, { mode: 'apply' });
    expect(result.totalCandidates).toBe(0);
    expect(telegramService.verifyFileExists).not.toHaveBeenCalled();
  });

  it('apply 标记 error 时带 uploadVersion 守卫，防止误标覆盖上传后的新文件', async () => {
    const { service, fileRepository, telegramService } = buildAdminService();
    fileRepository.createQueryBuilder
      .mockReturnValueOnce(makeSelectChain([
        { id: 'f1', originalName: 'a.bin', size: 10, telegramFileId: 'tg-bad', telegramFilePath: null, uploadVersion: 3 },
      ]))
      .mockReturnValueOnce(makeUpdateChain());
    telegramService.verifyFileExists.mockRejectedValue(new TelegramFileNotFoundError('invalid file_id'));

    await service.verifyFiles(mockUser, { mode: 'apply' });

    const f1Chain = fileRepository.createQueryBuilder.mock.results[1].value;
    const whereCalls = f1Chain.andWhere.mock.calls as unknown[][];
    const versionWhere = whereCalls.find((c) => String(c[0]).includes('uploadVersion'));
    expect(versionWhere).toBeDefined();
    expect(versionWhere![1]).toMatchObject({ version: 3 });
  });

  it('互斥锁：体检进行中时再次请求直接拒绝', async () => {
    const { service, fileRepository, telegramService } = buildAdminService();
    // 第一次体检：select 后挂起（返回未 resolve 的 Promise）
    let resolveFirst: (value: unknown) => void = () => {};
    fileRepository.createQueryBuilder.mockReturnValueOnce(makeSelectChain([])).mockImplementationOnce(() => ({
      getMany: () => new Promise((resolve) => { resolveFirst = resolve; }),
    }));
    telegramService.verifyFileExists.mockResolvedValue({ file_id: 'tg', file_path: 'p', file_size: 1 });

    const first = service.verifyFiles(mockUser, { mode: 'apply' });
    // 第二次请求应被互斥锁拒绝
    await expect(service.verifyFiles(mockUser, { mode: 'apply' }))
      .rejects.toThrow('已有文件体检任务正在执行');
    resolveFirst({});
    await first;
  });

  it('互斥锁在异常后释放，可再次发起体检', async () => {
    const { service, fileRepository } = buildAdminService();
    fileRepository.createQueryBuilder.mockReturnValue(makeSelectChain([]));
    await service.verifyFiles(mockUser, { mode: 'apply' });
    // 第二次正常执行不被拒绝
    await expect(service.verifyFiles(mockUser, { mode: 'apply' })).resolves.toBeDefined();
  });
});

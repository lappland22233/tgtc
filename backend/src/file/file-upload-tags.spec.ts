jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { FileService } from './file.service';
import { FileAccessControlService } from './file-access-control.service';
import { FileUploadConfigService } from './file-upload-config.service';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { ShareLink } from '../common/entities/share-link.entity';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';
import { DirectoryNamespaceService } from '../common/services/directory-namespace.service';
import { UploadJobService } from './upload-job.service';
import { FileCacheService } from './file-cache.service';
import { ThumbnailService } from './thumbnail.service';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '../common/entities/user.entity';

/**
 * M2/N1 回归：异步上传路径（uploadToTelegram）的标签写入必须与文件行写入同事务。
 * 原实现先提交文件行、再在事务外用 `this.fileRepository.manager` 补写标签，
 * 标签失败会在文件已落库后抛出普通「上传失败」，形成幽灵失败。
 */
const userId = '11111111-1111-4111-8111-111111111111';
const validTagId = '44444444-4444-4444-8444-444444444444';
const createdFileId = '55555555-5555-4555-8555-555555555555';

function makeUser(id: string): User {
  return { id } as User;
}

function makeMulterFile(): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'notes.txt',
    encoding: '7bit',
    mimetype: 'text/plain',
    buffer: Buffer.from('hello'),
    size: 5,
    destination: '',
    filename: 'notes.txt',
    path: '',
    stream: null as any,
  };
}

describe('FileService 上传标签事务（M2/N1）', () => {
  let service: FileService;
  let fileRepo: any;
  let auditServiceMock: { log: jest.Mock; logAwait: jest.Mock };
  let transactionQuery: jest.Mock;
  let transactionSave: jest.Mock;
  let nonTransactionalSave: jest.Mock;
  let telegramUploadFile: jest.Mock;

  beforeEach(async () => {
    transactionQuery = jest.fn().mockResolvedValue(undefined);
    transactionSave = jest.fn(async (entity: File) => entity);
    nonTransactionalSave = jest.fn(async (entity: File) => entity);
    auditServiceMock = { log: jest.fn(), logAwait: jest.fn() };

    const txManager = {
      getRepository: jest.fn(() => ({ save: transactionSave })),
      query: transactionQuery,
    };
    fileRepo = {
      findOne: jest.fn(),
      // File.id 由数据库生成；模拟仓储时补一个稳定 id 以便断言 file_tags 写入。
      create: jest.fn((data: Partial<File>) => Object.assign(new File(), { id: createdFileId }, data)),
      save: nonTransactionalSave,
      update: jest.fn().mockResolvedValue(undefined),
      manager: {
        transaction: jest.fn(async (cb: (m: any) => unknown) => cb(txManager)),
        query: jest.fn().mockResolvedValue(undefined),
      },
    };
    telegramUploadFile = jest.fn().mockResolvedValue({ file_id: 'tg-1', file_path: 'documents/x' });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FileService,
        // M6 拆分：上传配置 / 类型校验域（用真实实现，保证大小/类型校验行为不变）
        FileUploadConfigService,
        // M6 拆分：访问策略 / 密码 / 封禁域已下沉到 FileAccessControlService（本套件不涉及）
        { provide: FileAccessControlService, useValue: {} },
        { provide: getRepositoryToken(File), useValue: fileRepo },
        { provide: getRepositoryToken(Folder), useValue: { findOne: jest.fn() } },
        { provide: ThumbnailService, useValue: { deleteThumbnailsForFileId: jest.fn().mockResolvedValue(undefined) } },
        { provide: getRepositoryToken(FileAccessLog), useValue: {} },
        { provide: getRepositoryToken(BannedIP), useValue: {} },
        { provide: getRepositoryToken(ShareAudit), useValue: {} },
        { provide: getRepositoryToken(ShareLink), useValue: {} },
        { provide: TelegramService, useValue: { uploadFile: telegramUploadFile } },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        { provide: JwtService, useValue: {} },
        { provide: ConfigCacheService, useValue: { get: jest.fn(async (_k: string, fb: string) => fb) } },
        { provide: RateLimitService, useValue: {} },
        { provide: UploadJobService, useValue: {} },
        { provide: AuditService, useValue: auditServiceMock },
        {
          provide: DirectoryNamespaceService,
          useValue: { acquire: jest.fn(async () => undefined), release: jest.fn(async () => undefined) },
        },
        { provide: FileCacheService, useValue: { invalidate: jest.fn(), cacheFileFromPath: jest.fn() } },
        { provide: getQueueToken(QUEUE_NAMES.FILE_UPLOAD), useValue: { add: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(FileService);
  });

  const invoke = (tagIds?: string[]) =>
    (service as any).uploadToTelegram(makeMulterFile(), makeUser(userId), 'notes.txt', undefined, null, undefined, tagIds);

  it('把 file_tags 写入纳入文件行所在的同一事务', async () => {
    await invoke([validTagId]);

    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO file_tags'),
      [createdFileId, validTagId],
    );
    // 事务外 manager 不得再补写文件行
    expect(nonTransactionalSave).not.toHaveBeenCalled();
  });

  it('未传 tagIds 时不产生 file_tags 写入', async () => {
    await invoke(undefined);

    const tagInserts = transactionQuery.mock.calls.filter((c) => String(c[0]).includes('file_tags'));
    expect(tagInserts).toHaveLength(0);
  });

  it('标签写入失败时整个上传事务失败（不再出现已落库但报失败的幽灵文件）', async () => {
    transactionQuery.mockRejectedValueOnce(new Error('file_tags insert failed'));

    await expect(invoke([validTagId])).rejects.toThrow('file_tags insert failed');
    // 文件行写入与标签写入同处一个事务回调中：标签失败必然带着文件行一起回滚
    expect(transactionSave).toHaveBeenCalledTimes(1);
    expect(nonTransactionalSave).not.toHaveBeenCalled();
  });

  it('数据库事务失败时记录 Telegram 孤儿文件以便人工补偿', async () => {
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    transactionQuery.mockRejectedValueOnce(new Error('db down'));

    await expect(invoke([validTagId])).rejects.toThrow('db down');

    expect(telegramUploadFile).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join('\n')).toContain('tg-1');
    warn.mockRestore();
  });

  /**
   * PERF-B-101：removeFileTag 的删除命中判定必须兼容双方言真实返回形状——
   * PG：DELETE ... RETURNING 经 TypeORM 返回 [rows, count] 元组，databaseQuery 归一化后按行数判定；
   * SQLite：RETURNING 走 sqliteAll() 返回行数组。旧写法 `result[1] === 0` 在 SQLite 下
   * （result[1] 恒为 undefined）判定恒假 → 「标签关联不存在」永不抛出（假成功）。
   */
  describe('removeFileTag 删除命中判定（PERF-B-101）', () => {
    const originalDbType = process.env.DB_TYPE;
    const owner = makeUser(userId);

    beforeEach(() => {
      fileRepo.findOne.mockResolvedValue({ id: createdFileId, uploaderId: userId });
    });

    afterEach(() => {
      if (originalDbType === undefined) delete process.env.DB_TYPE;
      else process.env.DB_TYPE = originalDbType;
    });

    it('PG 命中：元组 [[{tagId}], 1] 归一化后按行数判定成功，记录审计', async () => {
      process.env.DB_TYPE = 'postgres';
      fileRepo.manager.query.mockResolvedValue([[{ tagId: validTagId }], 1]);

      await expect(service.removeFileTag(createdFileId, owner, validTagId)).resolves.toBeUndefined();

      expect(fileRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING "tagId"'),
        [createdFileId, validTagId],
      );
      expect(auditServiceMock.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tag_set_file', metadata: { removedTagId: validTagId } }),
      );
    });

    it('PG 未命中：元组 [[], 0] 归一化为空 → 抛 NotFound「标签关联不存在」', async () => {
      process.env.DB_TYPE = 'postgres';
      fileRepo.manager.query.mockResolvedValue([[], 0]);

      await expect(service.removeFileTag(createdFileId, owner, validTagId)).rejects.toThrow('标签关联不存在');
      expect(auditServiceMock.log).not.toHaveBeenCalled();
    });

    it('SQLite 命中：RETURNING 经 sqliteAll 返回行数组 → 判定成功', async () => {
      process.env.DB_TYPE = 'sqlite';
      const all = jest.fn(
        (_sql: string, _params: unknown[], callback: (error: Error | null, rows: unknown[]) => void) =>
          callback(null, [{ tagId: validTagId }]),
      );
      fileRepo.manager.connection = { driver: { databaseConnection: { all } } };

      await expect(service.removeFileTag(createdFileId, owner, validTagId)).resolves.toBeUndefined();

      expect(all).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE FROM file_tags[\s\S]*RETURNING "tagId"/),
        [createdFileId, validTagId],
        expect.any(Function),
      );
      expect(auditServiceMock.log).toHaveBeenCalledTimes(1);
    });

    it('SQLite 未命中：空行数组 [] → 抛 NotFound（旧写法 result[1] 恒 undefined 会假成功）', async () => {
      process.env.DB_TYPE = 'sqlite';
      const all = jest.fn(
        (_sql: string, _params: unknown[], callback: (error: Error | null, rows: unknown[]) => void) =>
          callback(null, []),
      );
      fileRepo.manager.connection = { driver: { databaseConnection: { all } } };

      await expect(service.removeFileTag(createdFileId, owner, validTagId)).rejects.toThrow('标签关联不存在');
      expect(auditServiceMock.log).not.toHaveBeenCalled();
    });
  });
});

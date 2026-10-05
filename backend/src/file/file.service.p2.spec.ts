import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Readable } from 'stream';

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');

import { FileService } from './file.service';
import { FileAccessType } from '../common/entities/file.entity';
import { UserRole } from '../common/entities/user.entity';

/**
 * P2 批次 D1 关键修复的最小回归测试：
 * - G2-11：findAll limit 钳制（limit=0 / 超大 limit 回退默认）
 * - G2-15：Range 下载配额扣次 30s 幂等去重
 * - G2-12：batchToMarkdown 文件名转义 + 仅无约束公开文件生成直链
 */

function createService(overrides: Record<string, unknown> = {}): FileService {
  const service = Object.create(FileService.prototype) as FileService;
  Object.assign(service, {
    // Object.create 不会执行字段初始化器：补上 logger，保证告警分支（如懒触发 fail-open）可断言
    logger: new Logger('FileService'),
    fileRepository: { findOne: jest.fn(), createQueryBuilder: jest.fn(), manager: { query: jest.fn() } },
    fileCacheService: {
      getCachedPath: jest.fn(),
      getOrCacheRangeStream: jest.fn().mockResolvedValue(new Readable()),
    },
    accessLogRepository: { save: jest.fn() },
    configService: { get: jest.fn() },
    rangeQuotaDedup: new Map<string, number>(),
    ...overrides,
  });
  return service;
}

const user = {
  id: 'u-1',
  role: UserRole.USER,
  email: 'u@example.com',
} as any;

const readyFile = {
  id: 'f-1',
  originalName: 'a[1](x).png',
  mimeType: 'image/png',
  size: 100,
  uploaderId: 'u-1',
  accessType: FileAccessType.PUBLIC,
  isDeleted: false,
  status: 'ready',
  password: null,
  maxAccessCount: -1,
  expiresIn: null,
  expiresStartAt: null,
};

describe('G2-11: findAll limit 钳制', () => {
  function wireFindAll() {
    const taken: number[] = [];
    const qb: any = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockImplementation((n) => { taken.push(n); return qb; }),
      getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
    };
    const countQb: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    };
    // 主查询与 count 查询都用 alias 'file'，这里通过调用顺序区分：第一次返回主 qb，第二次返回 countQb
    let call = 0;
    const createQueryBuilder = jest.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? qb : countQb;
    });
    const service = createService({
      fileRepository: { createQueryBuilder, manager: { query: jest.fn().mockResolvedValue([]) } },
    });
    return { service, taken };
  }

  it('limit=0 回退默认 20 而非触发 500', async () => {
    const { service, taken } = wireFindAll();
    await (service as any).findAll(1, 0, 'u-1', undefined, false, undefined, undefined, undefined, undefined, undefined);
    expect(taken[0]).toBe(20);
  });

  it('超大 limit（1000）钳制到 100', async () => {
    const { service, taken } = wireFindAll();
    await (service as any).findAll(1, 1000, 'u-1', undefined, false, undefined, undefined, undefined, undefined, undefined);
    expect(taken[0]).toBe(100);
  });

  it('非法 limit（-5）回退默认 20', async () => {
    const { service, taken } = wireFindAll();
    await (service as any).findAll(1, -5, 'u-1', undefined, false, undefined, undefined, undefined, undefined, undefined);
    expect(taken[0]).toBe(20);
  });
});

describe('G2-15: Range 配额扣次 30s 幂等去重', () => {
  function wireRange() {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const qbUpdate: any = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: update,
    };
    const service = createService({
      fileRepository: {
        findOne: jest.fn().mockResolvedValue(readyFile),
        createQueryBuilder: jest.fn().mockReturnValue(qbUpdate),
      },
      fileCacheService: {
        getCachedPath: jest.fn().mockReturnValue('/tmp/cache/f-1'),
        isNoCacheMode: jest.fn().mockReturnValue(false),
        getOrCacheRangeStream: jest.fn().mockResolvedValue(new Readable()),
      },
      accessLogRepository: { save: jest.fn().mockResolvedValue({ id: 'log-1' }) },
    });
    return { service, update };
  }

  it('同文件同（用户+IP）30s 窗口内多次 Range 只扣一次配额', async () => {
    (fs.createReadStream as unknown as jest.Mock).mockReturnValue(new Readable() as any);
    const { service, update } = wireRange();
    const fixedNow = 1700000000000;
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const opts = { ip: '1.2.3.4' };
    await (service as any).getFileContentStreamWithRange('f-1', user, 'bytes=0-9', opts);
    await (service as any).getFileContentStreamWithRange('f-1', user, 'bytes=10-19', opts);
    await (service as any).getFileContentStreamWithRange('f-1', user, 'bytes=20-29', opts);

    expect(update).toHaveBeenCalledTimes(1);
    (Date.now as any).mockRestore();
  });

  it('不同 IP 的 Range 请求分别扣次', async () => {
    (fs.createReadStream as unknown as jest.Mock).mockReturnValue(new Readable() as any);
    const { service, update } = wireRange();
    const fixedNow = 1700000000000;
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

    await (service as any).getFileContentStreamWithRange('f-1', user, 'bytes=0-9', { ip: '1.1.1.1' });
    await (service as any).getFileContentStreamWithRange('f-1', user, 'bytes=0-9', { ip: '2.2.2.2' });

    expect(update).toHaveBeenCalledTimes(2);
    (Date.now as any).mockRestore();
  });
});

describe('G2-12: batchToMarkdown 转义与直链约束', () => {
  /**
   * PERF-B-103 后 batchToMarkdown 共查询 2 次：
   * 1) 主查询（按 ids + uploaderId 取文件）；2) 一次性批量查询公开候选（PUBLIC 且未删除）。
   * 用 mockResolvedValueOnce 按调用顺序模拟；publicCandidates 为空即等价于「无约束公开判定为 false」。
   */
  function wireMarkdown(files: any[], publicCandidates: any[] = []) {
    const find = jest.fn()
      .mockResolvedValueOnce(files)
      .mockResolvedValueOnce(publicCandidates);
    const service = createService({
      fileRepository: { find },
      configService: { get: jest.fn().mockReturnValue('https://cdn.example.com') },
    });
    return { service, find };
  }

  it('文件名中的 Markdown 特殊字符被转义，含约束文件生成分享链接', async () => {
    const { service } = wireMarkdown([readyFile]);
    const results = await (service as any).batchToMarkdown(['f-1'], user);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe('[a\\[1\\]\\(x\\).png](https://cdn.example.com/s/f-1)');
  });

  it('无约束公开文件生成 /media/ 直链', async () => {
    const { service } = wireMarkdown([readyFile], [readyFile]);
    const results = await (service as any).batchToMarkdown(['f-1'], user);
    expect(results[0]).toBe('![a\\[1\\]\\(x\\).png](https://cdn.example.com/media/f-1)');
  });

  it('批量判定与单文件判定语义一致：带密码约束的公开文件仍生成分享链接', async () => {
    const { service } = wireMarkdown([readyFile], [{ ...readyFile, password: 'has-password' }]);
    const results = await (service as any).batchToMarkdown(['f-1'], user);
    expect(results[0]).toBe('[a\\[1\\]\\(x\\).png](https://cdn.example.com/s/f-1)');
  });

  it('输出数量与顺序不变：非图片文件跳过，其余按原顺序输出', async () => {
    const textFile = { ...readyFile, id: 'f-txt', originalName: 'note.txt', mimeType: 'text/plain' };
    const restricted = { ...readyFile, id: 'f-2', originalName: 'b.png' };
    const { service, find } = wireMarkdown([readyFile, textFile, restricted], [readyFile]);

    const results = await (service as any).batchToMarkdown(['f-1', 'f-txt', 'f-2'], user);
    expect(results).toEqual([
      '![a\\[1\\]\\(x\\).png](https://cdn.example.com/media/f-1)',
      '[b.png](https://cdn.example.com/s/f-2)',
    ]);
    // 公开候选为一次批量查询（不再是逐文件 findOne）
    expect(find).toHaveBeenCalledTimes(2);
    const publicQueryArg = find.mock.calls[1][0];
    expect(publicQueryArg.where.isDeleted).toBe(false);
    expect(publicQueryArg.where.accessType).toBe(FileAccessType.PUBLIC);
    expect(publicQueryArg.select).toEqual(['id', 'password', 'maxAccessCount', 'expiresIn', 'expiresStartAt']);
  });
});

/**
 * Web 下载入口的扩散契约（受控懒触发）：
 * - 取流参数必须**只含定位与缓存控制**：不传期望副本数，下载路径不执行任何扩散动作；
 * - 老文件补扩散由 `TelegramMirrorLazyTriggerService` 在账号池分支「问一声」完成：
 *   fire-and-forget、零字节（只建镜像任务）、不参与取流决策、失败不影响下载。
 */
describe('Web 下载入口：不携带扩散参数，仅受控懒触发建单', () => {
  function wire(overrides: Record<string, unknown> = {}) {
    const openStream = jest.fn(async (..._args: unknown[]) => ({
      stream: Readable.from([Buffer.from('x')]),
      info: { file_id: 'pooled-file-id', file_size: 1 },
      accountId: 'bot-a',
      copy: null,
      selectionReason: 'weighted',
    }));
    const lazyMirrorTrigger = { maybeTrigger: jest.fn() };
    const service = createService({
      accountAwareDownload: { isActive: () => true, openStream },
      fileCopies: { listReady: jest.fn(async () => [{ accountId: 'bot-a', telegramFileId: 'x' }]) },
      lazyMirrorTrigger,
      ...overrides,
    });
    return { service, openStream, lazyMirrorTrigger };
  }

  it('回源参数只含定位与缓存控制，不含任何扩散字段', async () => {
    const { service, openStream } = wire();

    const result = await (service as any).openTelegramSourceStream(
      { id: 'f-1', originalName: 'a.bin', filename: 'a.bin' } as any,
      1024,
    );

    expect(openStream).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'file',
      ownerId: 'f-1',
      expectedSize: 1024,
      fileName: 'a.bin',
    }));
    const params = openStream.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('desiredReplicas');
    expect(params).not.toHaveProperty('fileName_');
    expect(result.info.file_id).toBe('pooled-file-id');
  });

  it('无可用副本时不进入池化路径（保持单账号链路语义）', async () => {
    const getRealtimeFileStream = jest.fn(async () => ({
      stream: Readable.from([Buffer.from('y')]),
      info: { file_id: 'legacy-file-id', file_path: 'p', file_size: 1 },
    }));
    const { service, openStream } = wire({
      fileCopies: { listReady: jest.fn(async () => []) },
      telegramService: { getRealtimeFileStream },
    });

    const result = await (service as any).openTelegramSourceStream(
      { id: 'f-2', originalName: 'a.bin', filename: 'a.bin' } as any,
      8,
    );

    expect(openStream).not.toHaveBeenCalled();
    expect(getRealtimeFileStream).toHaveBeenCalledWith('a.bin', 8, { noCache: false });
    expect(result.info.file_id).toBe('legacy-file-id');
  });

  it('账号池分支内懒触发「问一声」，且不等待其完成、不影响取流结果', async () => {
    const { service, openStream, lazyMirrorTrigger } = wire();

    const result = await (service as any).openTelegramSourceStream(
      { id: 'f-3', originalName: 'a.bin', filename: 'a.bin' } as any,
      1024,
    );

    expect(lazyMirrorTrigger.maybeTrigger).toHaveBeenCalledWith('file', 'f-3');
    // 懒触发不是取流参数：openStream 仍只收到定位与缓存控制
    expect(openStream).toHaveBeenCalledTimes(1);
    expect(result.info.file_id).toBe('pooled-file-id');
  });

  it('懒触发同步抛错不影响下载结果（fail-open）', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, openStream } = wire({
      lazyMirrorTrigger: {
        maybeTrigger: jest.fn(() => {
          throw new Error('lazy trigger exploded');
        }),
      },
    });

    const result = await (service as any).openTelegramSourceStream(
      { id: 'f-4', originalName: 'a.bin', filename: 'a.bin' } as any,
      1024,
    );

    // 补扩散失败只告警：取流仍走池化路径，绝不因此降级或抛错
    expect(openStream).toHaveBeenCalledTimes(1);
    expect(result.info.file_id).toBe('pooled-file-id');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('老文件补扩散懒触发失败'));
  });

  it('未装配懒触发（可选依赖缺失）→ 零行为，下载链路逐字节等价', async () => {
    const { service, openStream } = wire({ lazyMirrorTrigger: undefined });

    const result = await (service as any).openTelegramSourceStream(
      { id: 'f-5', originalName: 'a.bin', filename: 'a.bin' } as any,
      1024,
    );

    expect(openStream).toHaveBeenCalledTimes(1);
    expect(result.info.file_id).toBe('pooled-file-id');
  });
});

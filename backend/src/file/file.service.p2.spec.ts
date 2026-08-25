import 'reflect-metadata';
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
  function wireMarkdown(files: any[]) {
    const isUnrestricted = jest.fn().mockResolvedValue(false);
    const service = createService({
      fileRepository: { find: jest.fn().mockResolvedValue(files) },
      configService: { get: jest.fn().mockReturnValue('https://cdn.example.com') },
    });
    (service as any).isUnrestrictedPublic = isUnrestricted;
    return { service, isUnrestricted };
  }

  it('文件名中的 Markdown 特殊字符被转义，含约束文件生成分享链接', async () => {
    const { service } = wireMarkdown([readyFile]);
    const results = await (service as any).batchToMarkdown(['f-1'], user);
    expect(results).toHaveLength(1);
    expect(results[0]).toBe('[a\\[1\\]\\(x\\).png](https://cdn.example.com/s/f-1)');
  });

  it('无约束公开文件生成 /media/ 直链', async () => {
    const { service, isUnrestricted } = wireMarkdown([readyFile]);
    isUnrestricted.mockResolvedValue(true);
    const results = await (service as any).batchToMarkdown(['f-1'], user);
    expect(results[0]).toBe('![a\\[1\\]\\(x\\).png](https://cdn.example.com/media/f-1)');
  });
});

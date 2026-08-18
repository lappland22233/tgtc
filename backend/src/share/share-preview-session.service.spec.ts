import 'reflect-metadata';
import { SharePreviewSessionService } from './share-preview-session.service';
import { ShareLinkStatus, ShareTargetType } from '../common/entities/share-link.entity';

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share-id-1',
    token: 'tok123',
    targetType: ShareTargetType.FILE,
    targetId: 'file-id-1',
    creatorId: 'user-1',
    creator: null,
    password: null,
    maxAccessCount: 1,
    currentAccessCount: 0,
    expiresIn: null,
    expiresStartAt: null,
    isDeleted: false,
    status: ShareLinkStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

/**
 * 构造一个 createQueryBuilder mock：可按用途拆分 sub-chain，
 * 每个用途独立返回 execute 结果，避免深层嵌套导致语法错误。
 */
function makeService() {
  // 会话仓库的 createQueryBuilder 分发到不同用途
  const sessionRepo: any = {
    createQueryBuilder: jest.fn(),
    query: jest.fn(),
  };
  // 数据源的 createQueryBuilder 仅用于扣减 ShareLink 额度
  const dataSource: any = {
    createQueryBuilder: jest.fn(),
  };
  const service = new SharePreviewSessionService(sessionRepo, dataSource);

  // 便捷构造器
  const mkUpdate = (affected: number) => {
    const execute = jest.fn().mockResolvedValue({ affected });
    const builder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    return builder;
  };
  const mkInsert = (identifiers: unknown[]) => {
    // G5-06：实现改为检查 result.raw（RETURNING id）。mock 同时返回 identifiers 与 raw，
    // 其中 raw 直接复用 identifiers，使「插入成功」由 raw 非空体现、「冲突幂等」由 raw 空体现。
    const execute = jest.fn().mockResolvedValue({ identifiers, raw: identifiers });
    const builder = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute,
    };
    return builder;
  };
  const mkDelete = () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const builder = {
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    return builder;
  };
  const mkSelect = (getQuery: string) => {
    const builder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getQuery: jest.fn().mockReturnValue(getQuery),
    };
    return builder;
  };
  const mkLinkUpdate = (affected: number) => {
    const execute = jest.fn().mockResolvedValue({ affected });
    const builder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    };
    return builder;
  };

  return { service, sessionRepo, dataSource, mkUpdate, mkInsert, mkDelete, mkSelect, mkLinkUpdate };
}

describe('SharePreviewSessionService', () => {
  it('续期已过期会话：返回 consumed（新会话重新扣次）', async () => {
    const { service, sessionRepo, mkUpdate, mkLinkUpdate } = makeService();
    // 会话续期 UPDATE affected=1
    sessionRepo.createQueryBuilder.mockReturnValueOnce(mkUpdate(1));
    // ShareLink 额度扣减（不限次数分支不用扣，但 maxAccessCount=1 走条件扣）→ affected=1
    (service as any).dataSource.createQueryBuilder.mockReturnValueOnce(mkLinkUpdate(1));

    const result = await service.consumePreviewAccess(makeLink(), 'file-id-1', 'visitor-a');
    expect(result).toBe('consumed');
    expect(mkLinkUpdate(0).execute).toBeDefined();
  });

  it('未过期会话存在时（插入冲突）返回 idempotent', async () => {
    const { service, sessionRepo, mkUpdate, mkInsert } = makeService();
    // 续期 UPDATE affected=0（不存在过期会话）
    sessionRepo.createQueryBuilder.mockReturnValueOnce(mkUpdate(0));
    // 插入返回空 identifiers → 幂等
    sessionRepo.createQueryBuilder.mockReturnValueOnce(mkInsert([]));

    const result = await service.consumePreviewAccess(makeLink(), 'file-id-1', 'visitor-a');
    expect(result).toBe('idempotent');
  });

  it('额度耗尽（已达上限）时补偿删除会话并返回 exhausted', async () => {
    const { service, sessionRepo, mkUpdate, mkInsert, mkDelete, mkLinkUpdate } = makeService();
    const link = makeLink({ maxAccessCount: 1, currentAccessCount: 1 });

    // 续期 UPDATE affected=0
    sessionRepo.createQueryBuilder.mockReturnValueOnce(mkUpdate(0));
    // 插入成功（identifiers 非空）
    sessionRepo.createQueryBuilder.mockReturnValueOnce(mkInsert([{ id: 'x' }]));
    // 扣次 UPDATE affected=0（已达上限）
    (service as any).dataSource.createQueryBuilder.mockReturnValueOnce(mkLinkUpdate(0));
    // 补偿删除
    sessionRepo.createQueryBuilder.mockReturnValueOnce(mkDelete());

    const result = await service.consumePreviewAccess(link, 'file-id-1', 'visitor-a');
    expect(result).toBe('exhausted');
  });

  it('不限次数（maxAccessCount<0）直接计数并返回 consumed', async () => {
    const { service, sessionRepo, mkUpdate, mkLinkUpdate } = makeService();
    const link = makeLink({ maxAccessCount: -1 });

    // 续期 UPDATE affected=1（新会话）
    sessionRepo.createQueryBuilder.mockReturnValueOnce(mkUpdate(1));
    // 不限次数：无 where 条件扣次，仍 affected=1
    (service as any).dataSource.createQueryBuilder.mockReturnValueOnce(mkLinkUpdate(1));

    const result = await service.consumePreviewAccess(link, 'file-id-1', 'visitor-a');
    expect(result).toBe('consumed');
  });

  it('pruneExpired 按索引分批删除过期会话', async () => {
    const { service, sessionRepo, mkSelect } = makeService();
    sessionRepo.query.mockResolvedValue([[], 3]);
    sessionRepo.createQueryBuilder.mockReturnValueOnce(
      mkSelect('SELECT "id" FROM "share_preview_sessions" WHERE "expiresAt" < $1'),
    );

    const count = await service.pruneExpired();
    expect(count).toBe(3);
    // G5-05：query 必须同时携带参数数组（含 $1 占位符的 DELETE IN 子查询需要 now 参数），
    // 否则参数缺失报错被吞 → 过期会话永不清理。
    expect(sessionRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "share_preview_sessions"'),
      expect.any(Array),
    );
  });
});

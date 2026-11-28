import 'reflect-metadata';
import { SharePreviewSessionService } from './share-preview-session.service';
import { ShareLink } from '../common/entities/share-link.entity';

function makeService() {
  const sessionRepo: any = { createQueryBuilder: jest.fn(), manager: { query: jest.fn() } };
  const service = new SharePreviewSessionService(sessionRepo, {} as any);
  const mkSelect = (getQuery: string) => {
    const builder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getQueryAndParameters: jest.fn().mockReturnValue([getQuery, [new Date()]]),
    };
    return builder;
  };
  return { service, sessionRepo, mkSelect };
}

describe('SharePreviewSessionService', () => {
  describe('pruneExpired 删除计数（PERF-B-102）', () => {
    const originalDbType = process.env.DB_TYPE;

    afterEach(() => {
      if (originalDbType === undefined) delete process.env.DB_TYPE;
      else process.env.DB_TYPE = originalDbType;
    });

    const wireSubQuery = (sessionRepo: any, mkSelect: any) => {
      sessionRepo.createQueryBuilder.mockReturnValueOnce(
        mkSelect('SELECT "id" FROM "share_preview_sessions" WHERE "expiresAt" < $1'),
      );
    };

    it('PostgreSQL 命中：元组 [[3 行], 3] 归一化后按真实删除行数返回 3', async () => {
      process.env.DB_TYPE = 'postgres';
      const { service, sessionRepo, mkSelect } = makeService();
      wireSubQuery(sessionRepo, mkSelect);
      sessionRepo.manager.query.mockResolvedValue(
        [[{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }], 3], // TypeORM PostgresQueryRunner DELETE 元组形状
      );

      await expect(service.pruneExpired()).resolves.toBe(3);
      // G5-05：DELETE IN 子查询含 $1 占位符，必须携带参数数组，且语句须带 RETURNING 才能统计行数。
      expect(sessionRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "share_preview_sessions"'),
        expect.any(Array),
      );
      expect(sessionRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING "id"'),
        expect.any(Array),
      );
    });

    it('PostgreSQL 未命中：元组 [[], 0] 归一化为空 → 返回 0', async () => {
      process.env.DB_TYPE = 'postgres';
      const { service, sessionRepo, mkSelect } = makeService();
      wireSubQuery(sessionRepo, mkSelect);
      sessionRepo.manager.query.mockResolvedValue([[], 0]);

      await expect(service.pruneExpired()).resolves.toBe(0);
    });

    it('SQLite 命中：返回行数组 [{id}×2] → 按真实删除行数返回 2（旧写法恒 0）', async () => {
      process.env.DB_TYPE = 'sqlite';
      const { service, sessionRepo, mkSelect } = makeService();
      wireSubQuery(sessionRepo, mkSelect);
      // SQLite 驱动返回行数组
      sessionRepo.manager.query.mockResolvedValue([{ id: 's-1' }, { id: 's-2' }]);

      await expect(service.pruneExpired()).resolves.toBe(2);
      // SQLite 占位符翻译：$1 → ?
      expect(sessionRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('?'),
        expect.any(Array),
      );
    });

    it('SQLite 未命中：空数组 [] → 返回 0', async () => {
      process.env.DB_TYPE = 'sqlite';
      const { service, sessionRepo, mkSelect } = makeService();
      wireSubQuery(sessionRepo, mkSelect);
      sessionRepo.manager.query.mockResolvedValue([]);

      await expect(service.pruneExpired()).resolves.toBe(0);
    });

    it('SQLite RETURNING：按驱动返回行数返回 1', async () => {
      process.env.DB_TYPE = 'sqlite';
      const { service, sessionRepo, mkSelect } = makeService();
      wireSubQuery(sessionRepo, mkSelect);
      sessionRepo.manager.query.mockResolvedValue([{ id: 's-9' }]);

      await expect(service.pruneExpired()).resolves.toBe(1);
      expect(sessionRepo.manager.query).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE[\s\S]*RETURNING "id"/),
        [expect.any(String)], // 参数 now 在 SQLite 下转换为可比较的 UTC 文本
      );
    });
  });

  describe('退款与幂等 follower 竞态（B-01 / B-05）', () => {
    function makeHarness(opts: {
      hitCount: number | null;
      deleteAffected?: number;
      deleteThrows?: boolean;
      type?: string;
    }) {
      const countUpdate = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const links = {
        findOne: jest.fn().mockResolvedValue({ id: 'link-1' }),
        createQueryBuilder: jest.fn().mockReturnValue(countUpdate),
      };
      const sessions = {
        findOne: jest.fn().mockResolvedValue(
          opts.hitCount === null ? null : { hitCount: opts.hitCount },
        ),
        delete: jest.fn().mockImplementation(async () => {
          if (opts.deleteThrows) throw new Error('session delete failed');
          return { affected: opts.deleteAffected ?? 1 };
        }),
        increment: jest.fn().mockResolvedValue(undefined),
      };
      const manager = {
        getRepository: jest.fn((entity: any) => (entity === ShareLink ? links : sessions)),
      };
      const dataSource: any = {
        options: { type: opts.type ?? 'postgres' },
        transaction: jest.fn(async (fn: any) => fn(manager)),
      };
      const service = new SharePreviewSessionService({} as any, dataSource);
      return { service, links, sessions, countUpdate };
    }

    it('会话已被幂等命中（hitCount>0）时放弃退款：follower 已凭它取流，退款会抹掉其额度', async () => {
      const { service, sessions, countUpdate } = makeHarness({ hitCount: 2 });

      await expect(service.refundConsumedSession('link-1', 'file-1', 'vh')).resolves.toBe(false);
      expect(sessions.delete).not.toHaveBeenCalled();
      expect(countUpdate.execute).not.toHaveBeenCalled();
    });

    it('无幂等命中时删会话与退计数同事务执行，且退计数带 >0 条件', async () => {
      const { service, sessions, countUpdate } = makeHarness({ hitCount: 0 });

      await expect(service.refundConsumedSession('link-1', 'file-1', 'vh')).resolves.toBe(true);
      expect(sessions.delete).toHaveBeenCalledWith({
        shareLinkId: 'link-1', fileId: 'file-1', visitorHash: 'vh',
      });
      expect(countUpdate.andWhere).toHaveBeenCalledWith('"currentAccessCount" > 0');
      expect(countUpdate.execute).toHaveBeenCalledTimes(1);
    });

    it('会话不存在（并发退款/已过期清理）时不退款，避免重复退', async () => {
      const { service, countUpdate } = makeHarness({ hitCount: null });

      await expect(service.refundConsumedSession('link-1', 'file-1', 'vh')).resolves.toBe(false);
      expect(countUpdate.execute).not.toHaveBeenCalled();
    });

    it('会话删除失败时事务回滚，绝不退计数（旧实现吞失败仍退款＝免费窗口）', async () => {
      const { service, countUpdate } = makeHarness({ hitCount: 0, deleteThrows: true });

      await expect(service.refundConsumedSession('link-1', 'file-1', 'vh'))
        .rejects.toThrow('session delete failed');
      expect(countUpdate.execute).not.toHaveBeenCalled();
    });

    it('删除未命中任何行时不退计数', async () => {
      const { service, countUpdate } = makeHarness({ hitCount: 0, deleteAffected: 0 });

      await expect(service.refundConsumedSession('link-1', 'file-1', 'vh')).resolves.toBe(false);
      expect(countUpdate.execute).not.toHaveBeenCalled();
    });

    it('退款与扣次共用同一把分享行锁（PG pessimistic_write）', async () => {
      const { service, links } = makeHarness({ hitCount: 0 });

      await service.refundConsumedSession('link-1', 'file-1', 'vh');
      expect(links.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('幂等命中必须登记 hitCount，否则 leader 退款无从判定', async () => {
      const { service, sessions } = makeHarness({ hitCount: 0 });
      const identity = { shareLinkId: 'link-1', fileId: 'file-1', visitorHash: 'vh' };
      sessions.findOne.mockResolvedValue({
        ...identity, consumed: true, hitCount: 0, expiresAt: new Date(Date.now() + 60000),
      });
      // consumePreviewAccess 走同一 manager；分享行需处于可用状态
      await expect(
        service.consumePreviewAccess({ id: 'link-1' } as any, 'file-1', 'vh'),
      ).resolves.toBe('idempotent');
      expect(sessions.increment).toHaveBeenCalledWith(identity, 'hitCount', 1);
    });
  });
});

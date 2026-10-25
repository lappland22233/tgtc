import 'reflect-metadata';
import { SharePreviewSessionService } from './share-preview-session.service';

function makeService() {
  const sessionRepo: any = { createQueryBuilder: jest.fn(), manager: { query: jest.fn() } };
  const service = new SharePreviewSessionService(sessionRepo, {} as any);
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
      // SQLite RETURNING 无 connection 时兜底走 query()，返回纯行数组
      sessionRepo.manager.query.mockResolvedValue([{ id: 's-1' }, { id: 's-2' }]);

      await expect(service.pruneExpired()).resolves.toBe(2);
      // SQLite 占位符翻译：$1 → ?1
      expect(sessionRepo.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('?1'),
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

    it('SQLite 真实 RETURNING 路径（sqliteAll）：按 all() 回调行数返回 1', async () => {
      process.env.DB_TYPE = 'sqlite';
      const { service, sessionRepo, mkSelect } = makeService();
      wireSubQuery(sessionRepo, mkSelect);
      const all = jest.fn(
        (_sql: string, _params: unknown[], callback: (error: Error | null, rows: unknown[]) => void) =>
          callback(null, [{ id: 's-9' }]),
      );
      sessionRepo.manager.connection = { driver: { databaseConnection: { all } } };

      await expect(service.pruneExpired()).resolves.toBe(1);
      expect(all).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE[\s\S]*RETURNING "id"/),
        [expect.any(String)], // 参数 now 在 SQLite 下转换为可比较的 UTC 文本
        expect.any(Function),
      );
    });
  });
});

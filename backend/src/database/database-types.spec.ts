import { databasePessimisticWriteLock, databaseQuery } from './database-types';

/**
 * TypeORM 的 PostgresQueryRunner 对 `UPDATE`/`DELETE` 返回 `[rows, affectedCount]`
 * 元组，而 SELECT/INSERT 返回纯 rows 数组。未归一化会让所有「按行数判断」的调用方
 * 静默失效（Bot 每日配额永不生效、告警一键确认数量错报）。
 */
describe('databaseQuery 返回值归一化（PG UPDATE/DELETE 元组）', () => {
  const pgRunner = (result: unknown) => ({ query: jest.fn(async () => result) });

  it('解包 PostgreSQL UPDATE ... RETURNING 的 [rows, affected] 元组', async () => {
    const runner = pgRunner([[{ issuedCount: 3 }], 1]);
    await expect(
      databaseQuery(runner, 'UPDATE "t" SET "issuedCount" = "issuedCount" + 1 RETURNING "issuedCount"', [], 'postgres'),
    ).resolves.toEqual([{ issuedCount: 3 }]);
  });

  it('零行 UPDATE 归一化为 []（而非 [[], 0]），使「未命中」判定可达', async () => {
    const runner = pgRunner([[], 0]);
    await expect(databaseQuery(runner, 'UPDATE "t" SET x = 1', [], 'postgres')).resolves.toEqual([]);
  });

  it('多行 UPDATE 保留全部返回行', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const runner = pgRunner([rows, 2]);
    await expect(databaseQuery(runner, 'UPDATE "t" SET x = 1 RETURNING id', [], 'postgres'))
      .resolves.toEqual(rows);
  });

  it('不会误伤恰好返回 2 行的 SELECT（首元素是对象而非数组）', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const runner = pgRunner(rows);
    await expect(databaseQuery(runner, 'SELECT id FROM "t"', [], 'postgres')).resolves.toBe(rows);
  });

  it('空 SELECT 结果与非数组结果原样返回', async () => {
    const emptyRunner = pgRunner([]);
    await expect(databaseQuery(emptyRunner, 'SELECT id FROM "t"', [], 'postgres')).resolves.toEqual([]);

    const lastIdRunner = pgRunner(7);
    await expect(
      databaseQuery(lastIdRunner, 'INSERT INTO "t" (id) VALUES ($1)', ['x'], 'postgres'),
    ).resolves.toBe(7);
  });

  it('SQLite 方言不做元组解包（其 RETURNING 路径由 sqliteAll 单独处理）', async () => {
    const runner = pgRunner([[], 0]);
    await expect(databaseQuery(runner, 'UPDATE "t" SET x = 1', [], 'sqlite')).resolves.toEqual([[], 0]);
  });
});

/**
 * 行锁方言差异：TypeORM 的 SQLite 驱动不支持 `pessimistic_write`，传入会抛
 * `LockNotSupportedOnGivenDriverError`——这不是「少一层保护」，而是整条路径 500
 * （覆盖上传、删除/恢复）。因此必须按方言省略，SQLite 的写事务本身已串行化。
 */
describe('databasePessimisticWriteLock（行锁仅 PG 可用）', () => {
  it('PostgreSQL 返回 pessimistic_write 行锁选项', () => {
    expect(databasePessimisticWriteLock({ DB_TYPE: 'postgres' } as NodeJS.ProcessEnv))
      .toEqual({ lock: { mode: 'pessimistic_write' } });
  });

  it('SQLite 返回空对象（驱动不支持行锁，传入会直接抛错）', () => {
    expect(databasePessimisticWriteLock({ DB_TYPE: 'sqlite' } as NodeJS.ProcessEnv)).toEqual({});
  });

  it('未设置 DB_TYPE 时按默认 postgres 处理，保持既有加锁行为', () => {
    expect(databasePessimisticWriteLock({} as NodeJS.ProcessEnv))
      .toEqual({ lock: { mode: 'pessimistic_write' } });
  });
});

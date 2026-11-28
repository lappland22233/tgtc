import 'reflect-metadata';
import { MetricsAggregationProcessor } from './metrics-aggregation.processor';
import { databaseQuery, getDatabaseType } from '../database/database-types';

jest.mock('../database/database-types', () => ({
  // 实体装饰器依赖 databaseColumnType 等同模块导出，必须保留真实实现
  ...jest.requireActual('../database/database-types'),
  getDatabaseType: jest.fn(() => 'postgres'),
  databaseQuery: jest.fn(async () => []),
}));

/**
 * B-13：指标预聚合此前零直接测试。它是全部流量/错误告警与 Usage Analytics 的数据源，
 * 口径错了会让告警系统性误报或漏报。
 *
 * 关键不变量：
 * - 滞后一个窗口（G8-19）：聚合已完整结束的上一分钟，否则尾部日志未落库会系统性漏计；
 * - qpsAvg 用固定 60s 分母，不是 MAX-MIN 跨度（单条记录时跨度为 0 会把计数当 QPS）；
 * - 零请求窗口不写指标行；
 * - SQLite 无 PERCENTILE_CONT，必须本地线性插值算 p95；
 * - 按 windowTime upsert，重跑幂等；
 * - 失败必须抛出供 Bull 重试，不能吞掉。
 */
const mockedDbType = getDatabaseType as jest.Mock;
const mockedQuery = databaseQuery as jest.Mock;

const WINDOW_END = '2026-01-01T00:04:00.000Z';
const WINDOW_START = '2026-01-01T00:03:00.000Z';

function makeProcessor(raw: Record<string, string> | null) {
  const qb: any = {
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn(() => qb),
    getRawOne: jest.fn().mockResolvedValue(raw),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    manager: {},
  };
  const processor = new MetricsAggregationProcessor(repo as any);
  (processor as any).logger = { warn: jest.fn(), log: jest.fn() };
  return { processor, qb, repo };
}

function makeJob() {
  // due = 00:05:00 → 上一个已闭合分钟 = 00:04:00
  return { data: { windowTime: '2026-01-01T00:05:00.000Z' }, opts: {} } as any;
}

const RAW = {
  totalRequests: '120',
  qpsAvg: '2.00',
  error5xxCount: '3',
  error4xxCount: '7',
  totalBandwidth: '1048576',
  p95Duration: '250',
  uniqueIps: '9',
};

describe('MetricsAggregationProcessor（B-13）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedDbType.mockReturnValue('postgres');
    mockedQuery.mockResolvedValue([]);
  });

  it('聚合窗口滞后一个分钟：[windowTime-60s, windowTime)', async () => {
    const { processor, qb } = makeProcessor(RAW);
    await processor.aggregate1Min(makeJob());

    const [, params] = qb.where.mock.calls[0];
    expect(params.windowTime.toISOString()).toBe(WINDOW_END);
    expect(params.windowStart.toISOString()).toBe(WINDOW_START);
  });

  it('qpsAvg 用固定 60s 分母，而不是 MAX-MIN 时间跨度', async () => {
    const { processor, qb } = makeProcessor(RAW);
    await processor.aggregate1Min(makeJob());

    const selects = qb.addSelect.mock.calls.map((c: any[]) => c[0]).join(' ');
    expect(selects).toContain('/ 60.0');
    expect(selects).not.toContain('MAX(');
  });

  it('零请求窗口不写指标行', async () => {
    const { processor } = makeProcessor({ ...RAW, totalRequests: '0' });
    await processor.aggregate1Min(makeJob());
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('查询返回 null 时不写指标行', async () => {
    const { processor } = makeProcessor(null);
    await processor.aggregate1Min(makeJob());
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('PostgreSQL 用 PERCENTILE_CONT，并按 windowTime upsert（重跑幂等）', async () => {
    const { processor, qb } = makeProcessor(RAW);
    await processor.aggregate1Min(makeJob());

    const selects = qb.addSelect.mock.calls.map((c: any[]) => c[0]).join(' ');
    expect(selects).toContain('PERCENTILE_CONT(0.95)');

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [, sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT ("windowTime") DO UPDATE');
    expect(params[0].toISOString()).toBe(WINDOW_END);
    expect(params[1]).toBe(120);
    expect(params[2]).toBe(2);
    expect(params[7]).toBe(9);
  });

  it('SQLite 不用 PERCENTILE_CONT，改本地线性插值算 p95', async () => {
    mockedDbType.mockReturnValue('sqlite');
    const { processor, qb } = makeProcessor({ ...RAW, p95Duration: '0' });
    // 20 条 duration：position = 19 * 0.95 = 18.05 → 介于第 19、20 条之间
    const rows = Array.from({ length: 20 }, (_, i) => ({ duration: (i + 1) * 10 }));
    mockedQuery.mockImplementation(async (_m: any, sql: string) =>
      sql.includes('SELECT duration') ? rows : []);

    await processor.aggregate1Min(makeJob());

    const selects = qb.addSelect.mock.calls.map((c: any[]) => c[0]).join(' ');
    expect(selects).not.toContain('PERCENTILE_CONT');

    const insert = mockedQuery.mock.calls.find((c: any[]) => String(c[1]).includes('INSERT'));
    expect(insert).toBeDefined();
    // 190 + (200 - 190) * 0.05 = 190.5
    expect(insert![2][6]).toBeCloseTo(190.5, 5);
  });

  it('SQLite 单条 duration 时 p95 等于该值', async () => {
    mockedDbType.mockReturnValue('sqlite');
    const { processor } = makeProcessor({ ...RAW, p95Duration: '0' });
    mockedQuery.mockImplementation(async (_m: any, sql: string) =>
      sql.includes('SELECT duration') ? [{ duration: 42 }] : []);

    await processor.aggregate1Min(makeJob());

    const insert = mockedQuery.mock.calls.find((c: any[]) => String(c[1]).includes('INSERT'));
    expect(insert![2][6]).toBe(42);
  });

  it('SQLite duration 全为非有限值时 p95 归零，不产生 NaN', async () => {
    mockedDbType.mockReturnValue('sqlite');
    const { processor } = makeProcessor({ ...RAW, p95Duration: '0' });
    mockedQuery.mockImplementation(async (_m: any, sql: string) =>
      sql.includes('SELECT duration') ? [{ duration: NaN }, { duration: Infinity }] : []);

    await processor.aggregate1Min(makeJob());

    const insert = mockedQuery.mock.calls.find((c: any[]) => String(c[1]).includes('INSERT'));
    expect(insert![2][6]).toBe(0);
  });

  it('聚合失败必须抛出供 Bull 重试，且记日志', async () => {
    const { processor, qb } = makeProcessor(RAW);
    qb.getRawOne.mockRejectedValue(new Error('db down'));

    await expect(processor.aggregate1Min(makeJob())).rejects.toThrow('db down');
    expect((processor as any).logger.warn).toHaveBeenCalled();
  });

  it('写指标失败同样抛出，不静默丢失窗口', async () => {
    const { processor } = makeProcessor(RAW);
    mockedQuery.mockRejectedValue(new Error('write failed'));
    await expect(processor.aggregate1Min(makeJob())).rejects.toThrow('write failed');
  });
});
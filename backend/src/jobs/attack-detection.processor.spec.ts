import { AttackDetectionProcessor } from './attack-detection.processor';

function buildProcessor() {
  const accessLogRepo = { createQueryBuilder: jest.fn() };
  const auditLogRepo = { create: jest.fn() };
  const dataSource = { transaction: jest.fn() };
  const alertGateway = { broadcastAlert: jest.fn() };
  const configCacheService = {
    get: jest.fn(async (_k: string, fallback: string) => fallback),
  };
  const p = new AttackDetectionProcessor(
    accessLogRepo as any,
    auditLogRepo as any,
    dataSource as any,
    alertGateway as any,
    configCacheService as any,
  );
  return { p, accessLogRepo, auditLogRepo, dataSource, alertGateway, configCacheService };
}

/** 构造 accessLog 聚合查询链（getRawMany 返回 rows） */
function makeAggQueryChain(rows: any[]) {
  const q: any = {};
  q.select = jest.fn(() => q);
  q.addSelect = jest.fn(() => q);
  q.where = jest.fn(() => q);
  q.andWhere = jest.fn(() => q);
  q.groupBy = jest.fn(() => q);
  q.having = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.getRawMany = jest.fn(() => Promise.resolve(rows));
  return q;
}

describe('AttackDetectionProcessor 白名单与降级 (G8-05/G8-06)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('爬虫检测命中 IP 白名单时豁免（不产出攻击结果）', async () => {
    const { p, accessLogRepo, configCacheService } = buildProcessor();
    // 白名单包含监控 IP
    configCacheService.get.mockImplementation(async (k: string, fb: string) =>
      k === 'sec_ip_whitelist' ? '1.2.3.4' : fb,
    );
    accessLogRepo.createQueryBuilder.mockReturnValue(
      makeAggQueryChain([
        { ip: '1.2.3.4', totalRequests: '60000', getCount: '59900', uniquePaths: '2', userAgent: 'SomeBot/1.0' },
      ]),
    );

    const results = await (p as any).detectCrawlers();
    expect(results).toEqual([]);
  });

  it('爬虫检测命中监控 UA 时豁免', async () => {
    const { p, accessLogRepo } = buildProcessor();
    accessLogRepo.createQueryBuilder.mockReturnValue(
      makeAggQueryChain([
        { ip: '9.9.9.9', totalRequests: '60000', getCount: '59900', uniquePaths: '100', userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      ]),
    );

    const results = await (p as any).detectCrawlers();
    expect(results).toEqual([]);
  });

  it('爬虫检测单一成功路径流量降级为仅告警（downgradedToAlert=true）', async () => {
    const { p, accessLogRepo } = buildProcessor();
    accessLogRepo.createQueryBuilder.mockReturnValue(
      makeAggQueryChain([
        { ip: '8.8.8.8', totalRequests: '60000', getCount: '59900', uniquePaths: '1', userAgent: 'curl/7.68' },
      ]),
    );

    const results = await (p as any).detectCrawlers();
    expect(results).toHaveLength(1);
    expect(results[0].details.downgradedToAlert).toBe(true);
  });

  it('爆破检测命中 IP 白名单时豁免', async () => {
    const { p, accessLogRepo, configCacheService } = buildProcessor();
    configCacheService.get.mockImplementation(async (k: string, fb: string) =>
      k === 'sec_ip_whitelist' ? '10.0.0.0/8' : fb,
    );
    accessLogRepo.createQueryBuilder.mockReturnValue(
      makeAggQueryChain([{ ip: '10.1.2.3', loginAttempts: '100' }]),
    );

    const results = await (p as any).detectBruteForce();
    expect(results).toEqual([]);
  });

  it('异常下载对共享出口（多个已认证用户）降级为仅告警', async () => {
    const { p, accessLogRepo } = buildProcessor();
    accessLogRepo.createQueryBuilder.mockReturnValue(
      makeAggQueryChain([
        { ip: '203.0.113.5', downloadCount: '5000', distinctUsers: '5' },
      ]),
    );

    const results = await (p as any).detectAbnormalDownloads();
    expect(results).toHaveLength(1);
    expect(results[0].details.downgradedToAlert).toBe(true);
  });

  it('异常下载对非共享出口正常触发检测（不降级）', async () => {
    const { p, accessLogRepo } = buildProcessor();
    accessLogRepo.createQueryBuilder.mockReturnValue(
      makeAggQueryChain([
        { ip: '203.0.113.9', downloadCount: '5000', distinctUsers: '0' },
      ]),
    );

    const results = await (p as any).detectAbnormalDownloads();
    expect(results).toHaveLength(1);
    expect(results[0].details.downgradedToAlert).toBe(false);
  });
});

describe('AttackDetectionProcessor parseDuration 钳制 (G8-15)', () => {
  let p: AttackDetectionProcessor;
  beforeEach(() => {
    const { p: proc } = buildProcessor();
    p = proc;
  });

  it('解析常规时长', () => {
    expect((p as any).parseDuration('2h')).toBe(7200);
    expect((p as any).parseDuration('30m')).toBe(1800);
    expect((p as any).parseDuration('60s')).toBe(60);
  });

  it('0h/0m 钳制到最小 1 分钟，避免封禁即时过期', () => {
    expect((p as any).parseDuration('0h')).toBe(60);
    expect((p as any).parseDuration('0m')).toBe(60);
    expect((p as any).parseDuration('0s')).toBe(60);
  });

  it('非法格式回退默认 3600 秒', () => {
    expect((p as any).parseDuration('abc')).toBe(3600);
    expect((p as any).parseDuration('')).toBe(3600);
    expect((p as any).parseDuration('1.5h')).toBe(3600);
  });
});

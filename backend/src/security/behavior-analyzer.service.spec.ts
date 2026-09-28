import { BehaviorAnalyzer, buildPostgresBaselineSql } from './behavior-analyzer.service';

// 静态守卫：无 PG 实例也要守住「不得对 ordered-set 聚合叠加窗口函数」。
// 生产事故：`PERCENTILE_CONT(0.99) WITHIN GROUP (...) OVER ()` 在 PostgreSQL 上
// 直接报错，导致 5 个指标的基线计算连续约 30 天 100% 失败。
describe('buildPostgresBaselineSql', () => {
  const sql = buildPostgresBaselineSql('"totalBandwidth"');

  it('P99 截断使用标量子查询，不含 OVER ()', () => {
    expect(sql).not.toMatch(/OVER\s*\(/i);
    expect(sql).toContain('SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "totalBandwidth")');
  });

  it('保持抗投毒与原子 UPSERT 语义：两处过滤条件一致 + ON CONFLICT 更新', () => {
    const occurrences = (needle: string) => sql.split(needle).length - 1;
    // 主查询与标量子查询必须使用完全相同的 7 天 / 有流量过滤条件
    expect(occurrences(`"windowTime" >= NOW() - INTERVAL '7 days'`)).toBe(2);
    expect(occurrences(`"totalRequests" > 0`)).toBe(2);
    expect(occurrences('PERCENTILE_CONT(0.99)')).toBe(1);
    expect(sql).toContain('AVG("totalBandwidth") AS mean');
    expect(sql).toContain('COALESCE(STDDEV("totalBandwidth"), 0) AS stddev');
    expect(sql).toContain('ON CONFLICT ("metricName", "hourBucket", "dayOfWeek") DO UPDATE');
  });
});

describe('BehaviorAnalyzer',()=>{
 const ds:any={query:jest.fn()}; const cache:any={get:jest.fn().mockImplementation((_k:string,d:string)=>d)}; const s=new BehaviorAnalyzer(ds,cache);
 beforeEach(()=>{jest.clearAllMocks();cache.get.mockImplementation((_k:string,d:string)=>Promise.resolve(d))});
 it('calculates all baseline metrics and isolates individual query failures',async()=>{ds.query.mockResolvedValue([]); await s.calculateBaselines(); expect(ds.query).toHaveBeenCalledTimes(10); ds.query.mockRejectedValue(new Error('db')); await expect(s.calculateBaselines()).resolves.toBeUndefined()});
 it('maps all primary anomaly rows',async()=>{ds.query
  .mockResolvedValueOnce([{ip:'1.1.1.1',unique_files:51,distinct_users:2,total_downloads:60}])
  .mockResolvedValueOnce([{uploaderId:'u',upload_count:101}])
  .mockResolvedValueOnce([{fileId:'f',unique_ips:201,total_access:300}])
  // v1.2.6 契约：night_count/night_hours/all_avg；nightAvg=night_count/3=100，
  // 门槛（≥300 次、≥60/h、>3×全天均值 30）全部满足时才产生 time_anomaly
  .mockResolvedValueOnce([{night_count:300,night_hours:3,all_avg:10}])
  .mockResolvedValueOnce([])
  .mockResolvedValueOnce([]);
 const r=await s.detectAnomalies(); expect(r.map(x=>x.type)).toEqual(['abnormal_download','abnormal_upload','abnormal_sharing','time_anomaly'])});
 it('detects regular no-UA crawler and baseline deviations',async()=>{const timestamps=Array.from({length:10},(_,i)=>({ip:'bot',createdAt:new Date(i*10)})); ds.query
  .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
  .mockResolvedValueOnce([{ip:'bot',request_count:101}]).mockResolvedValueOnce(timestamps)
  .mockResolvedValueOnce([{qpsAvg:20,totalRequests:100,error5xxCount:10,totalBandwidth:1000}])
  .mockResolvedValueOnce([{metricName:'qps',mean:10,stddev:1},{metricName:'error_rate',mean:0,stddev:0.01},{metricName:'bandwidth',mean:900,stddev:100},{metricName:'unknown',mean:0,stddev:1}]);
 const r=await s.detectAnomalies(); expect(r.some(x=>x.type==='crawler_enhanced')).toBe(true); expect(r.filter(x=>x.type==='baseline_deviation').length).toBeGreaterThan(0)});
 it('handles empty and failed baseline queries without failing anomaly run',async()=>{ds.query.mockResolvedValue([]); await expect(s.detectAnomalies()).resolves.toEqual([]); ds.query.mockImplementationOnce(()=>Promise.resolve([])).mockImplementationOnce(()=>Promise.resolve([])).mockImplementationOnce(()=>Promise.resolve([])).mockImplementationOnce(()=>Promise.resolve([])).mockImplementationOnce(()=>Promise.resolve([])).mockRejectedValueOnce(new Error('db')); await expect(s.detectAnomalies()).resolves.toEqual([])});
});

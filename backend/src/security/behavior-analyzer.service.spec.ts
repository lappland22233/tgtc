import { BehaviorAnalyzer } from './behavior-analyzer.service';

describe('BehaviorAnalyzer',()=>{
 const ds:any={query:jest.fn()}; const cache:any={get:jest.fn().mockImplementation((_k:string,d:string)=>d)}; const s=new BehaviorAnalyzer(ds,cache);
 beforeEach(()=>{jest.clearAllMocks();cache.get.mockImplementation((_k:string,d:string)=>Promise.resolve(d))});
 it('calculates all baseline metrics and isolates individual query failures',async()=>{ds.query.mockResolvedValue([]); await s.calculateBaselines(); expect(ds.query).toHaveBeenCalledTimes(10); ds.query.mockRejectedValue(new Error('db')); await expect(s.calculateBaselines()).resolves.toBeUndefined()});
 it('maps all primary anomaly rows',async()=>{ds.query
  .mockResolvedValueOnce([{ip:'1.1.1.1',unique_files:51,distinct_users:2,total_downloads:60}])
  .mockResolvedValueOnce([{uploaderId:'u',upload_count:101}])
  .mockResolvedValueOnce([{fileId:'f',unique_ips:201,total_access:300}])
  .mockResolvedValueOnce([{night_avg:30,all_avg:10}])
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

import { AlertEvaluationProcessor, BaselineCalculationProcessor, AnomalyDetectionProcessor, DataArchivalProcessor, WeeklyReportProcessor } from './other.processors';

describe('other processors', () => {
  const job = {} as any;
  it('evaluates and broadcasts alerts, handles no metrics and rethrows failures', async () => {
    const ds: any = { query: jest.fn() }; const engine: any = { evaluateAndCreateAlerts: jest.fn() }; const gateway: any = { broadcastAlert: jest.fn() };
    const p = new AlertEvaluationProcessor(ds,engine,gateway);
    // G3-16：预聚合缺失时不再静默 return，而是 throw 触发 Bull 重试
    ds.query.mockResolvedValueOnce([]); await expect(p.evaluateAlerts(job)).rejects.toThrow('缺失'); expect(engine.evaluateAndCreateAlerts).not.toHaveBeenCalled();
    const alert = { id:'a',ruleId:'r',level:'warning',title:'t',message:null,createdAt:new Date() };
    ds.query.mockResolvedValueOnce([{}]); engine.evaluateAndCreateAlerts.mockResolvedValue([alert]); await p.evaluateAlerts(job);
    expect(gateway.broadcastAlert).toHaveBeenCalledWith(expect.objectContaining({ id:'a',message:'' }));
    ds.query.mockRejectedValueOnce(new Error('db')); await expect(p.evaluateAlerts(job)).rejects.toThrow('db');
  });

  it('calculates baseline and rethrows failures', async () => {
    const analyzer: any = { calculateBaselines: jest.fn() }; const p = new BaselineCalculationProcessor(analyzer);
    await p.calculateBaseline(job); analyzer.calculateBaselines.mockRejectedValueOnce(new Error('x')); await expect(p.calculateBaseline(job)).rejects.toThrow('x');
  });

  it('maps anomalies to alerts and broadcasts them', async () => {
    const analyzer: any = { detectAnomalies: jest.fn() }; const engine: any = { createAlerts: jest.fn() }; const gateway: any = { broadcastAlert: jest.fn() };
    const p = new AnomalyDetectionProcessor(analyzer,engine,gateway);
    analyzer.detectAnomalies.mockResolvedValueOnce([]); await p.detectAnomalies(job); expect(engine.createAlerts).not.toHaveBeenCalled();
    analyzer.detectAnomalies.mockResolvedValueOnce([
      {type:'download',severity:'critical',title:'c',message:'m',details:{}},
      {type:'upload',severity:'high',title:'h',message:'m',details:{}},
      {type:'share',severity:'low',title:'l',message:'m',details:{}},
    ]);
    engine.createAlerts.mockResolvedValue([{id:'a',ruleId:'r',level:'info',title:'t',createdAt:new Date()}]);
    await p.detectAnomalies(job); expect(engine.createAlerts.mock.calls[0][0].map((x:any)=>x.level)).toEqual(['critical','warning','info']);
    analyzer.detectAnomalies.mockRejectedValueOnce(new Error('x')); await expect(p.detectAnomalies(job)).rejects.toThrow('x');
  });

  it('archives data in batches for both access_logs and file_access_logs (G8-13), supports both driver result shapes', async () => {
    // G8-13：归档同时清理 access_logs 与 file_access_logs。
    // 每个表各执行 2 次查询（首批发 1000 条继续，末批发 2 条结束）。
    const ds: any = { query: jest.fn()
      .mockResolvedValueOnce([{rowCount:1000}]).mockResolvedValueOnce([{rowCount:2}])   // access_logs
      .mockResolvedValueOnce([{rowCount:1000}]).mockResolvedValueOnce([{rowCount:2}])   // file_access_logs
    };
    await new DataArchivalProcessor(ds).archiveData(job); expect(ds.query).toHaveBeenCalledTimes(4);
    const ds2: any = { query: jest.fn().mockResolvedValue([[],3]) }; await new DataArchivalProcessor(ds2).archiveData(job);
    ds2.query.mockRejectedValueOnce(new Error('db')); await expect(new DataArchivalProcessor(ds2).archiveData(job)).rejects.toThrow('db');
  });

  it('generates weekly report from three queries and rethrows failures', async () => {
    const ds: any = { query: jest.fn().mockResolvedValueOnce([{total_requests:1,unique_visitors:1,total_bandwidth:1024,errors_5xx:0,errors_4xx:1}]).mockResolvedValueOnce([{new_users:2}]).mockResolvedValueOnce([{total_alerts:3,unacknowledged:1}]) };
    await new WeeklyReportProcessor(ds).generateWeeklyReport(job); expect(ds.query).toHaveBeenCalledTimes(3);
    ds.query.mockRejectedValueOnce(new Error('db')); await expect(new WeeklyReportProcessor(ds).generateWeeklyReport(job)).rejects.toThrow('db');
  });
});

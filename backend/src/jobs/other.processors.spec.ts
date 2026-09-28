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

  // 预聚合只在「该分钟有请求」时落行，无流量分钟必然查不到窗口。
  // 原实现对此同样 warn + throw 触发 Bull 重试，生产上日均刷出近万条 WARN。
  it('无流量分钟不重试：超过追赶期且该分钟访问日志为 0 时静默跳过评估', async () => {
    const ds: any = { query: jest.fn() }; const engine: any = { evaluateAndCreateAlerts: jest.fn() }; const gateway: any = { broadcastAlert: jest.fn() };
    const p = new AlertEvaluationProcessor(ds, engine, gateway);
    // 1 小时前的窗口：已远超追赶期（5 分钟）
    const staleWindow = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    ds.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ cnt: 0 }]);
    await expect(p.evaluateAlerts({ data: { windowTime: staleWindow } } as any)).resolves.toBeUndefined();
    expect(ds.query).toHaveBeenCalledTimes(2);
    expect(engine.evaluateAndCreateAlerts).not.toHaveBeenCalled();
  });

  it('聚合缺口不被吞掉：超过追赶期但该分钟有访问日志时仍然触发重试', async () => {
    const ds: any = { query: jest.fn() }; const engine: any = { evaluateAndCreateAlerts: jest.fn() }; const gateway: any = { broadcastAlert: jest.fn() };
    const p = new AlertEvaluationProcessor(ds, engine, gateway);
    const staleWindow = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    ds.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ cnt: 12 }]);
    await expect(p.evaluateAlerts({ data: { windowTime: staleWindow } } as any)).rejects.toThrow('缺失');
    expect(engine.evaluateAndCreateAlerts).not.toHaveBeenCalled();
  });
});

// crypto.util 依赖环境变量派生密钥，必须在任何加解密调用前设置
process.env.SMTP_ENCRYPTION_KEY = 'unit-test-encryption-key';
process.env.SMTP_ENCRYPTION_SALT = 'unit-test-encryption-salt';

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// FileService 依赖链含 file-type（ESM-only，jest CJS 环境无法解析），
// 且本测试仅关心 SMTP 逻辑，直接 mock 掉整个模块
jest.mock('../file/file.service', () => ({ FileService: class FileService {} }));

import { AdminService } from './admin.service';
import { SmtpTestDto, SmtpConfigDto } from './admin.dto';

/** AdminService 依赖较多，此处仅关心 SMTP 相关逻辑，其余依赖用空 mock 占位 */
function buildAdminService() {
  const repoMock = () => ({}) as any;
  const configCacheService = {
    get: jest.fn(async (_key: string, defaultValue: string) => defaultValue),
    setBatch: jest.fn(async (_configs: { key: string; value: string; description?: string }[]) => undefined),
    set: jest.fn(async () => undefined),
  };
  const auditService = { log: jest.fn() };
  const mailerService = { sendTestEmail: jest.fn(async () => undefined) };
  const service = new AdminService(
    repoMock(), // systemConfigRepository
    repoMock(), // bannedIPRepository
    repoMock(), // fileRepository
    repoMock(), // userRepository
    repoMock(), // accessLogRepository
    repoMock(), // accessLogRepo
    repoMock(), // auditLogRepo
    repoMock(), // telemetryRepo
    {} as any, // fileService
    configCacheService as any,
    auditService as any,
    {} as any, // exportService
    mailerService as any,
    {} as any, // telegramService
  );
  return { service, configCacheService, auditService, mailerService };
}

const mockUser = { id: 'user-1', email: 'admin@example.com' } as any;

const baseConfig = {
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  user: 'mailer@example.com',
  from: 'noreply@example.com',
};

describe('AdminService query condition branches', () => {
  const chain = (raw: any[] = []) => {
    const q: any = {};
    for (const m of ['where','andWhere','select','addSelect','groupBy','orderBy','leftJoin','setParameter','having','limit','skip','take']) q[m] = jest.fn(() => q);
    q.getCount = jest.fn().mockResolvedValue(raw.length);
    q.getMany = jest.fn().mockResolvedValue(raw);
    q.getRawMany = jest.fn().mockResolvedValue(raw);
    q.getRawOne = jest.fn().mockResolvedValue(raw[0]);
    q.getManyAndCount = jest.fn().mockResolvedValue([raw, raw.length]);
    return q;
  };
  const build = (raw: any[] = []) => {
    const { service } = buildAdminService();
    const access = (service as any).accessLogRepo;
    access.createQueryBuilder = jest.fn(() => chain(raw));
    (service as any).accessLogRepository.createQueryBuilder = jest.fn(() => chain(raw));
    (service as any).auditLogRepo.createQueryBuilder = jest.fn(() => chain(raw));
    (service as any).telemetryRepo.createQueryBuilder = jest.fn(() => chain(raw));
    return { service, access };
  };

  it('covers access log optional filters and pagination clamps', async () => {
    const { service, access } = build([{ id: 'x' }]);
    await service.getAccessLogs({ page: -1, limit: 500 });
    await service.getAccessLogs({ page: 2, limit: 0, startDate: '2026-01-01', endDate: '2026-02-01', path: '%_', statusCode: 404 });
    expect(access.createQueryBuilder).toHaveBeenCalledTimes(2);
  });

  it.each(['1h','24h','7d','30d','other'] as const)('covers time range and trend granularity %s', async (timeRange) => {
    const { service } = build([{ time:'t',requests:'2',bandwidth:'3' }]);
    await expect(service.getAccessLogTrend(timeRange)).resolves.toEqual([{time:'t',requests:2,bandwidth:3}]);
  });

  it('covers top file whitelist, filters and both sorting modes', async () => {
    let built = build([{fileId:'f',fileName:'n',mimeType:'x',fileSize:'2',accessCount:'3',totalBandwidth:'4'}]);
    await expect(built.service.getTopFiles({sortBy:'invalid'} as any)).rejects.toThrow();
    await built.service.getTopFiles({sortBy:'bandwidth',startDate:'2026-01-01',endDate:'2026-02-01',action:'download',limit:1} as any);
    built = build([]); await built.service.getTopFiles({} as any);
  });

  it('covers excluded paths, status filters and zero/error rates', async () => {
    let built = build([{path:'/x',requestCount:'2',totalBandwidth:'3',avgDuration:'4'}]);
    await built.service.getTopPaths({excludePaths:'admin, %_'} as any);
    built = build([{path:'/x',count2xx:'1',count3xx:'0',count4xx:'1',count5xx:'1',totalCount:'2'}]);
    const rows = await built.service.getStatusByPath({statusCode:0,minCount:0,limit:0} as any); expect(rows[0].errorRate).toBe(100);
    built = build([{path:'/x',count2xx:'0',count3xx:'0',count4xx:null,count5xx:null,totalCount:'0'}]);
    expect((await built.service.getStatusByPath({} as any))[0].errorRate).toBe(0);
  });

  it('covers latency sampled and unsampled query branches', async () => {
    let built = build([{avgDuration:'1',p50Duration:'2',p95Duration:'3',p99Duration:'4'}]);
    const access=(built.service as any).accessLogRepo; access.createQueryBuilder = jest.fn()
      .mockReturnValueOnce(Object.assign(chain(),{getCount:jest.fn().mockResolvedValue(1000001)}))
      .mockReturnValueOnce(Object.assign(chain(),{getRawOne:jest.fn().mockResolvedValue({avgDuration:'1'})}));
    await expect(built.service.getLatencyStats({startDate:'2026-01-01',endDate:'2026-02-01'} as any)).resolves.toMatchObject({sampled:true,totalRequests:1000001});
    built=build([]); await expect(built.service.getLatencyStats({} as any)).resolves.toMatchObject({avgDuration:0,totalRequests:0});
  });

  it('covers audit optional filters and username fallback', async () => {
    const { service }=build([{log_id:'i',log_userId:'u',username:'x'},{log_id:'j',username:''}]);
    const result=await service.getAuditLogs({page:0,limit:500,action:'a',userId:'u',timeRange:'7d'});
    expect(result.items.map(x=>x.username)).toEqual(['x',null]);
  });

  it('covers comparison zero, growth, decline and absent rows', async () => {
    let {service}=build();
    (service as any).accessLogRepo.manager={query:jest.fn().mockResolvedValueOnce([{requests:1,bandwidth:'2',uv:3}]).mockResolvedValueOnce([{requests:0,bandwidth:'0',uv:0}])};
    expect((await service.getComparison('1h')).changes).toEqual({requests:100,bandwidth:100,uv:100});
    ({service}=build());
    (service as any).accessLogRepo.manager={query:jest.fn().mockResolvedValueOnce([{requests:0,bandwidth:'0',uv:0}]).mockResolvedValueOnce([{requests:2,bandwidth:'4',uv:1}])};
    expect((await service.getComparison('bad')).changes).toEqual({requests:-100,bandwidth:-100,uv:-100});
    ({service}=build()); (service as any).accessLogRepo.manager={query:jest.fn().mockResolvedValue([])};
    expect((await service.getComparison()).current.requests).toBe(0);
    ({service}=build()); (service as any).accessLogRepo.manager={query:jest.fn().mockResolvedValueOnce([{requests:3,bandwidth:'6',uv:4}]).mockResolvedValueOnce([{requests:2,bandwidth:'4',uv:2}])};
    expect((await service.getComparison('30d')).changes).toEqual({requests:50,bandwidth:50,uv:100});
  });

  it('validates security config constraints atomically and saves valid entries', async () => {
    const {service,configCacheService,auditService}=buildAdminService();
    const meta=require('./security-config.defaults').SEC_CONFIG_META;
    await expect(service.updateSecurityConfig(mockUser,[{key:'invalid',value:'1'}])).rejects.toThrow('无效');
    const bounded=meta.find((m:any)=>m.min!==undefined&&m.max!==undefined);
    await expect(service.updateSecurityConfig(mockUser,[{key:bounded.key,value:'NaN'}])).rejects.toThrow('有效数值');
    await expect(service.updateSecurityConfig(mockUser,[{key:bounded.key,value:String(bounded.min-1)}])).rejects.toThrow('不能小于');
    await expect(service.updateSecurityConfig(mockUser,[{key:bounded.key,value:String(bounded.max+1)}])).rejects.toThrow('不能大于');
    await service.updateSecurityConfig(mockUser,[{key:bounded.key,value:String(bounded.min)}]);
    expect(configCacheService.setBatch).toHaveBeenCalled(); expect(auditService.log).toHaveBeenCalled();
    configCacheService.get.mockResolvedValue(''); expect((await service.getSecurityConfig()).length).toBe(meta.length);
  });

  it('covers telemetry record filters and pagination clamps', async () => {
    let {service}=build([{id:'1',type:'error'},{id:'2',type:'error'}]);
    const result=await service.getTelemetryRecords({page:0,limit:500,type:'error',ip:'1',userId:'u',errorType:'Type',keyword:'q',timeRange:'24h'});
    expect(result.items).toHaveLength(2);
    ({service}=build([]));
    await expect(service.getTelemetryRecords({type:'',ip:' ',userId:' ',errorType:' ',keyword:' '})).resolves.toEqual({items:[],total:0});
  });

  it('maps telemetry aggregates with missing and invalid numeric fields', async () => {
    const {service}=build(); const telemetry=(service as any).telemetryRepo;
    telemetry.createQueryBuilder=jest.fn()
      .mockReturnValueOnce(Object.assign(chain(),{getRawOne:jest.fn().mockResolvedValue(undefined)}))
      .mockReturnValueOnce(Object.assign(chain(),{getRawMany:jest.fn().mockResolvedValue([{type:'custom',count:'bad'}])}))
      .mockReturnValueOnce(Object.assign(chain(),{getRawOne:jest.fn().mockResolvedValue({uniqueIPs:null})}))
      .mockReturnValueOnce(Object.assign(chain(),{getRawMany:jest.fn().mockResolvedValue([{time:'t',error:null,apiError:'x',uploadError:'1',performance:'2',environment:'3'}])}));
    await expect(service.getTelemetryStats('bad')).resolves.toMatchObject({totalRecords:0,uniqueIPs:0,byType:{custom:0},trend:[{error:0,apiError:0,uploadError:1,performance:2,environment:3}]});
  });
});

describe('AdminService.updateSMTPConfig 密码处理', () => {
  it('提供新密码时加密后写入', async () => {
    const { service, configCacheService } = buildAdminService();

    await service.updateSMTPConfig(mockUser, { ...baseConfig, password: 'new-secret' });

    const saved = configCacheService.setBatch.mock.calls[0][0] as { key: string; value: string }[];
    const passwordEntry = saved.find((c) => c.key === 'SMTP_PASSWORD');
    expect(passwordEntry).toBeDefined();
    expect(passwordEntry!.value).toMatch(/^v2:/);
    expect(passwordEntry!.value).not.toContain('new-secret');
    // 未读取旧密码
    expect(configCacheService.get).not.toHaveBeenCalled();
  });

  it('密码留空时保留数据库中已有密文，不覆盖', async () => {
    const { service, configCacheService } = buildAdminService();
    const oldCipher = 'v2:iv:cipher:tag';
    configCacheService.get.mockResolvedValue(oldCipher);

    await service.updateSMTPConfig(mockUser, { ...baseConfig, password: '' });

    expect(configCacheService.get).toHaveBeenCalledWith('SMTP_PASSWORD', '');
    const saved = configCacheService.setBatch.mock.calls[0][0] as { key: string; value: string }[];
    const passwordEntry = saved.find((c) => c.key === 'SMTP_PASSWORD');
    expect(passwordEntry!.value).toBe(oldCipher);
  });

  it('密码字段未传（undefined）时同样保留旧密文', async () => {
    const { service, configCacheService } = buildAdminService();
    configCacheService.get.mockResolvedValue('v2:old');

    await service.updateSMTPConfig(mockUser, { ...baseConfig });

    const saved = configCacheService.setBatch.mock.calls[0][0] as { key: string; value: string }[];
    expect(saved.find((c) => c.key === 'SMTP_PASSWORD')!.value).toBe('v2:old');
  });

  it('保存成功后记录审计日志', async () => {
    const { service, auditService } = buildAdminService();
    await service.updateSMTPConfig(mockUser, { ...baseConfig, password: 'p' });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'smtp_config_change', userId: 'user-1' }),
    );
  });
});

describe('AdminService.sendTestSMTPMail', () => {
  it('委托 MailerService 发送并记录审计日志', async () => {
    const { service, mailerService, auditService } = buildAdminService();
    await service.sendTestSMTPMail(mockUser, 'to@example.com');
    expect(mailerService.sendTestEmail).toHaveBeenCalledWith('to@example.com');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'smtp_test_mail', metadata: { recipient: 'to@example.com' } }),
    );
  });

  it('MailerService 抛错时向上冒泡（由全局过滤器处理）', async () => {
    const { service, mailerService } = buildAdminService();
    mailerService.sendTestEmail.mockRejectedValue(new Error('SMTP 认证失败'));
    await expect(service.sendTestSMTPMail(mockUser, 'to@example.com')).rejects.toThrow('SMTP 认证失败');
  });
});

describe('SmtpTestDto 校验', () => {
  it('合法邮箱通过校验', async () => {
    const dto = plainToInstance(SmtpTestDto, { recipient: 'user@example.com' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('非法邮箱被拒绝', async () => {
    const dto = plainToInstance(SmtpTestDto, { recipient: 'not-an-email' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('recipient');
  });

  it('缺失 recipient 被拒绝', async () => {
    const dto = plainToInstance(SmtpTestDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SmtpConfigDto 密码可选', () => {
  it('不传 password 仍通过校验（二次保存无需重输密码）', async () => {
    const dto = plainToInstance(SmtpConfigDto, {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'mailer@example.com',
      from: 'noreply@example.com',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('password 传空字符串也通过校验', async () => {
    const dto = plainToInstance(SmtpConfigDto, {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'mailer@example.com',
      password: '',
      from: 'noreply@example.com',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('缺失必填字段仍被拒绝', async () => {
    const dto = plainToInstance(SmtpConfigDto, { port: 465 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

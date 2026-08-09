jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });

import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin/admin.controller';
import { UserController } from './user/user.controller';
import { FolderController } from './folder/folder.controller';
import { TagController } from './tag/tag.controller';
import { DashboardController } from './admin/dashboard.controller';
import { AlertController } from './alert/alert.controller';
import { ChunkUploadController } from './file/chunk-upload.controller';
import { AlertLevel } from './common/entities/alert.entity';

const serviceProxy = () => new Proxy({}, { get: (target: any, key: string) => target[key] ||= jest.fn().mockResolvedValue(key) }) as any;
const user: any = { id: 'u' };

describe('thin controllers', () => {
  it('covers admin delegation, parsing, defaults and validation', async () => {
    const service = serviceProxy();
    const c = new AdminController(service);
    for (const method of ['getStats','getConfig','getBannedIPs','getSMTPConfig','getUploadConfig','getCacheConfig','getAuthConfig','getBanStats','getSecurityConfig'] as const) await c[method]();
    await c.getMyFileStats(user); await c.updateConfig(user, { key: 'k', value: 'v' } as any);
    await c.updateConfigs(user, { configs: [] });
    await c.banIP(user, { ip: '1.2.3.4', reason: 'x', permanent: false, expiresAt: '2030-01-01' } as any);
    await c.unbanIP(user, '1.2.3.4'); await c.unbanIPByBody(user, { ip: '::1' });
    await expect(c.getAllFiles(1, 20, undefined, undefined, 'bad')).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.getAllFiles(1, 20, undefined, undefined, 'size', 'sideways')).rejects.toBeInstanceOf(BadRequestException);
    await c.getAllFiles(2, 10, 'q', 'u', 'size', 'DESC', 'cursor');
    await c.deleteFile(user, 'f'); await c.batchDeleteFiles(user, { ids: ['f'] });
    await c.updateSMTPConfig(user, {} as any); await c.sendTestSMTPMail(user, { recipient: 'a@b.com' });
    await c.updateUploadConfig(user, {} as any); await c.updateCacheConfig(user, {} as any); await c.updateAuthConfig(user, {} as any);
    const queryMethods = ['getRefererAnalysis','getUserAgentAnalysis','getUserActivityStats','getBandwidthAnalysis','getFileTypeStats','getTopFiles','getTopPaths','getLatencyStats','getStatusByPath','getDownloadStats','getAbnormalIps','getAccessLogs'] as const;
    for (const method of queryMethods) await c[method]({} as any);
    await c.getComparison(); await c.getAccessLogStats(); await c.getAccessLogTrend('24h');
    await c.getAuditLogs('2','3','x','u','7d'); await c.getTelemetryStats();
    await c.getTelemetryRecords('2','3','error','ip','u','type','q','7d');
    await c.getTelemetryPerformance(); await c.getTelemetryErrors('5');
    await c.updateSecurityConfig(user, { configs: {} } as any);
    expect(service.getAllFiles).toHaveBeenCalledWith(2,10,'q','u','size','DESC','cursor');
  });

  it('streams admin exports and validates export parameters', async () => {
    const service = serviceProxy();
    service.exportData.mockResolvedValue({ contentType: 'text/csv', filename: 'x.csv', data: 'a,b' });
    service.exportTelemetry.mockResolvedValue([{ id: 1 }]);
    const c = new AdminController(service);
    const res: any = { setHeader: jest.fn(), send: jest.fn(), set: jest.fn() };
    for (const args of [['xml','',''],['','1y',''],['','','users']]) await expect(c.exportData(args[0],args[1],args[2],res)).rejects.toBeInstanceOf(BadRequestException);
    await c.exportData('','','',res); await c.exportTelemetry(undefined,undefined,undefined,res);
    expect(res.send).toHaveBeenCalledTimes(2);
  });

  it('covers user controller parsing and mutations', async () => {
    const s = serviceProxy(); const c = new UserController(s);
    await c.findAll('bad','0','q'); await c.findAll('2','5'); await c.getMyStats(user); await c.findOne('id');
    await c.create({} as any,user); await c.updateRole('id',{ role: 'admin' } as any,user);
    await c.banUser('id',{ isBanned: true },user); await c.banUser('id',{ isBanned: false },user);
    await c.changePassword(user,{ oldPassword:'o',newPassword:'n' }); await c.delete('id',user);
    expect(s.findAll).toHaveBeenNthCalledWith(1,1,20,'q');
  });

  it('covers folder and tag controllers', async () => {
    const fs = serviceProxy(); const f = new FolderController(fs);
    await f.getTree(user); for (const value of [undefined,'','null','id']) await f.getBreadcrumb(user,value);
    await f.listContents(user,{ parentId:'null', includeDeleted:true }); await f.createFolder(user,{} as any);
    await f.renameFolder('id',user,{} as any); await f.moveFolder('id',user,{} as any); await f.softDeleteFolder('id',user); await f.restoreFolder('id',user);
    const ts = serviceProxy(); const t = new TagController(ts);
    await t.findAll(user); await t.create(user,{} as any); await t.update(user,'id',{} as any); await t.delete(user,'id');
  });

  it('covers dashboard and alert controllers', async () => {
    const ds = serviceProxy(); const d = new DashboardController(ds);
    await d.list(user); await d.getPresets(); await d.createFromPreset(user,'p'); await d.get('id',user);
    await d.create(user,{} as any); await d.create(user,{ name:'n',config:[{}],isDefault:true } as any); await d.update('id',user,{config:[]}); await d.delete('id',user);
    const as = serviceProxy(); as.acknowledgeAll.mockResolvedValue(3); const a = new AlertController(as);
    await a.getAlerts('2','5',AlertLevel.CRITICAL,'true'); await a.getAlerts(undefined,undefined,'bad','false');
    await a.getUnacknowledged(); await a.acknowledge('id',user); expect(await a.acknowledgeAll(user)).toEqual({ message:'已确认 3 条告警' });
    await a.getRules(); await a.updateRules();
  });

  it('covers chunk upload validation, cleanup and lifecycle', async () => {
    const s = serviceProxy(); const c = new ChunkUploadController(s);
    await c.init({ fileName:'x',fileSize:1,mimeType:'x',totalChunks:1,chunkSize:1 } as any,user); await c.getStatus('id',user);
    await expect(c.uploadChunk('id',undefined as any,'0',user)).rejects.toBeInstanceOf(BadRequestException);
    const chunk: any = { path:'p',size:1 };
    await expect(c.uploadChunk('id',chunk,'',user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.uploadChunk('id',chunk,'-1',user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.uploadChunk('id',chunk,'2',user)).resolves.toEqual({ index:2,received:true });
    expect(c.complete('id',user).status).toBe('processing'); await c.abort('id',user);
    expect(s.removeIncomingChunk).toHaveBeenCalledTimes(2);
  });
});

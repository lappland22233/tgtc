import { AccessLogMiddleware } from './access-log.middleware';

const response=()=>{const listeners:any={};return {statusCode:200,headersSent:false,socket:{bytesWritten:10},headers:{} as any,on:jest.fn((e:string,fn:any)=>listeners[e]=fn),getHeader:jest.fn((k:string)=>k==='content-length'?'12':undefined),listeners} as any};
describe('AccessLogMiddleware',()=>{
 jest.useFakeTimers(); const repo:any={insert:jest.fn()}; let m:AccessLogMiddleware;
 beforeEach(()=>{jest.clearAllMocks();repo.insert.mockResolvedValue({});m=new AccessLogMiddleware(repo)}); afterEach(()=>jest.clearAllTimers());
 it('skips noisy admin paths including query/trailing slash',()=>{for(const url of ['/api/admin/access-logs?x=1','/api/admin/alerts/']){const next=jest.fn();m.use({originalUrl:url} as any,response(),next);expect(next).toHaveBeenCalled()} expect(repo.insert).not.toHaveBeenCalled()});
 it('captures trusted request metadata and flushes on timer',async()=>{const res=response(),next=jest.fn();const req:any={originalUrl:'/api/files#x',method:'GET',ip:'1.2.3.4',ips:[],socket:{},user:{id:'u'},headers:{'user-agent':'ua','referer':'ref'}};m.use(req,res,next);res.socket.bytesWritten=30;res.listeners.finish();jest.runOnlyPendingTimers();await Promise.resolve();await Promise.resolve();expect(repo.insert).toHaveBeenCalledWith([expect.objectContaining({ip:'1.2.3.4',path:'/api/files',responseSize:20,userId:'u'})])});
 it('falls back to content length and tolerates insert failure',async()=>{repo.insert.mockRejectedValue(new Error('db'));const res=response(),req:any={url:'/x',method:'POST',ip:'bad',ips:[],socket:{remoteAddress:'::1'},headers:{}};m.use(req,res,jest.fn());res.listeners.finish();await m.onApplicationShutdown();expect(repo.insert).toHaveBeenCalledWith([expect.objectContaining({ip:'::1',responseSize:12,userId:null,userAgent:null,referer:null})])});
 it('shutdown safely handles empty buffer',async()=>{await expect(m.onApplicationShutdown()).resolves.toBeUndefined()});

 // 回归：客户端提前断开（大文件流式下载被截断）只 emit close、不 emit finish，
 // 历史上这条路径完全不落库，导致 Bot 直链使用统计恒为 0。
 it('records aborted responses on close without finish',async()=>{const res=response(),req:any={originalUrl:'/api/bot-dl/tokenabcdefgh12345678',method:'GET',ip:'149.154.161.1',ips:[],socket:{},botGrantId:'g-1',botTelegramUserId:'42',headers:{'user-agent':'TelegramBot (like TwitterBot)'}};m.use(req,res,jest.fn());res.headersSent=true;res.socket.bytesWritten=3000;res.listeners.close();jest.runOnlyPendingTimers();await Promise.resolve();await Promise.resolve();expect(repo.insert).toHaveBeenCalledWith([expect.objectContaining({path:'/api/bot-dl/tokenabcdefgh12345678',responseSize:2990,statusCode:200,botGrantId:'g-1',botTelegramUserId:'42'})])});

 it('does not double record when close follows finish',async()=>{const res=response(),req:any={originalUrl:'/api/files/x',method:'GET',ip:'1.2.3.4',ips:[],socket:{},headers:{}};m.use(req,res,jest.fn());res.socket.bytesWritten=110;res.listeners.finish();res.listeners.close();await m.onApplicationShutdown();expect(repo.insert).toHaveBeenCalledTimes(1);expect((repo.insert as jest.Mock).mock.calls[0][0]).toHaveLength(1)});

 it('skips close that happens before the response started',async()=>{const res=response(),req:any={originalUrl:'/api/files/x',method:'GET',ip:'1.2.3.4',ips:[],socket:{},headers:{}};m.use(req,res,jest.fn());res.listeners.close();await m.onApplicationShutdown();expect(repo.insert).not.toHaveBeenCalled()});

 it('still uses the captured socket after res.socket is nulled on finish',async()=>{const res=response(),req:any={originalUrl:'/api/files/y',method:'GET',ip:'1.2.3.4',ips:[],socket:{},headers:{}};m.use(req,res,jest.fn());res.socket.bytesWritten=64;res.socket=null;res.headersSent=true;res.listeners.finish();jest.runOnlyPendingTimers();await Promise.resolve();await Promise.resolve();expect(repo.insert).toHaveBeenCalledWith([expect.objectContaining({responseSize:54})])});
});

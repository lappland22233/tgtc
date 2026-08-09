import { HttpException } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';

describe('TelemetryController', () => {
  const telemetry: any = { report: jest.fn() };
  const rate: any = { checkAndIncrement: jest.fn() };
  const jwt: any = { verify: jest.fn() };
  const controller = new TelemetryController(telemetry,rate,jwt);
  const req = (overrides:any={}) => ({ ip:'127.0.0.1',ips:[],socket:{},cookies:{},headers:{'user-agent':'ua'},...overrides }) as any;
  beforeEach(() => { jest.clearAllMocks(); rate.checkAndIncrement.mockResolvedValue({allowed:true}); });

  it('reports anonymous events and defaults missing list', async () => {
    await expect(controller.report({events:[]} as any,req())).resolves.toEqual({code:0,message:'ok',count:0});
    await expect(controller.report({} as any,req())).resolves.toEqual({code:0,message:'ok',count:0});
    expect(telemetry.report).toHaveBeenCalledWith([], '127.0.0.1','ua',undefined);
  });

  it('associates valid cookie and bearer JWT subjects', async () => {
    jwt.verify.mockReturnValue({sub:'u'});
    await controller.report({events:[{type:'error',data:{}}]} as any,req({cookies:{access_token:'a.b.c'}}));
    expect(telemetry.report).toHaveBeenLastCalledWith(expect.anything(),expect.anything(),expect.anything(),'u');
    await controller.report({events:[]} as any,req({headers:{authorization:'Bearer a.b.c'}}));
    expect(jwt.verify).toHaveBeenCalledWith('a.b.c',{algorithms:['HS256']});
  });

  it.each(['bad','a.b'])('treats malformed token %s as anonymous', async token => {
    await controller.report({events:[]} as any,req({cookies:{access_token:token}}));
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('treats invalid signature or subject as anonymous', async () => {
    jwt.verify.mockImplementationOnce(() => { throw new Error('bad'); }).mockReturnValueOnce({sub:1});
    await controller.report({events:[]} as any,req({cookies:{access_token:'a.b.c'}}));
    await controller.report({events:[]} as any,req({cookies:{access_token:'a.b.c'}}));
    expect(telemetry.report).toHaveBeenLastCalledWith(expect.anything(),expect.anything(),expect.anything(),undefined);
  });

  it('rejects limited requests with configured and default wait', async () => {
    rate.checkAndIncrement.mockResolvedValueOnce({allowed:false,waitMinutes:2}).mockResolvedValueOnce({allowed:false});
    await expect(controller.report({events:[]} as any,req())).rejects.toMatchObject({status:429});
    await expect(controller.report({events:[]} as any,req())).rejects.toThrow('5 分钟');
  });

  it.each([[-1], [Infinity], ['1']])('rejects invalid performance metrics %p', async value => {
    await expect(controller.report({events:[{type:'performance',data:{dns:value}}]} as any,req())).rejects.toBeInstanceOf(HttpException);
  });

  it('accepts finite performance metrics and ignores unrelated events', async () => {
    const events:any=[{type:'performance',data:{dns:0,tcp:1,ttfb:2,domReady:3,pageLoad:4,fcp:5}},{type:'error',data:{dns:-1}}];
    await expect(controller.report({events} as any,req())).resolves.toEqual(expect.objectContaining({count:2}));
  });
});

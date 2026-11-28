import 'reflect-metadata';
import { of, throwError, firstValueFrom } from 'rxjs';
import { TransformInterceptor } from './transform.interceptor';

/**
 * B-13：全局响应契约此前零直接测试。
 *
 * 该拦截器决定所有成功响应的形状（{code,message,data}），前端 api/client.ts
 * 按此解包。契约回归会同时打穿前后端，必须有直接保护。
 */
function makeContext(headersSent = false) {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ headersSent }),
      getRequest: () => ({}),
    }),
  } as any;
}

function makeHandler(value: unknown) {
  return { handle: () => of(value) } as any;
}

describe('TransformInterceptor（全局成功响应契约）', () => {
  const interceptor = new TransformInterceptor();

  it('成功响应统一包装为 { code: 0, message: "success", data }', async () => {
    const payload = { id: 'f-1', name: 'a.txt' };
    const result = await firstValueFrom(
      interceptor.intercept(makeContext(), makeHandler(payload)),
    );
    expect(result).toEqual({ code: 0, message: 'success', data: payload });
  });

  it('headersSent（@Res() 流式下载）时原样透传，不得二次包装', async () => {
    const raw = Buffer.from('file-bytes');
    const result = await firstValueFrom(
      interceptor.intercept(makeContext(true), makeHandler(raw)),
    );
    expect(result).toBe(raw);
  });

  it.each([null, undefined, 0, '', false])(' falsy 数据 %s 仍被包装，data 字段保留', async (value) => {
    const result = await firstValueFrom(
      interceptor.intercept(makeContext(), makeHandler(value)),
    );
    expect(result).toEqual({ code: 0, message: 'success', data: value });
  });

  it('数组与分页对象按原样放入 data，不改写内部结构', async () => {
    const page = { items: [{ id: '1' }], total: 1, page: 1, pageSize: 20 };
    const result = await firstValueFrom(
      interceptor.intercept(makeContext(), makeHandler(page)),
    );
    expect(result).toEqual({ code: 0, message: 'success', data: page });
  });

  it('异常原样透传给 GlobalExceptionFilter，本拦截器不吞不改', async () => {
    const error = new Error('boom');
    const handler = { handle: () => throwError(() => error) } as any;
    await expect(
      firstValueFrom(interceptor.intercept(makeContext(), handler)),
    ).rejects.toBe(error);
  });

  it('控制器自行返回 {code,message,data} 时会被再包一层（契约：控制器不得自行包装）', async () => {
    const selfWrapped = { code: 0, message: 'success', data: { id: 'x' } };
    const result = await firstValueFrom(
      interceptor.intercept(makeContext(), makeHandler(selfWrapped)),
    );
    expect(result).toEqual({ code: 0, message: 'success', data: selfWrapped });
  });
});
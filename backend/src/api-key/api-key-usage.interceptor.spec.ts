import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import { of, throwError, firstValueFrom, lastValueFrom } from 'rxjs';
import { ApiKeyUsageInterceptor } from './api-key-usage.interceptor';
import { getApiKeyContext } from '../common/auth-context';

jest.mock('../common/auth-context', () => ({
  getApiKeyContext: jest.fn(),
}));

/**
 * B-13：API 密钥使用审计拦截器此前零直接测试。
 *
 * 关键不变量：
 * - 只记录 API Key 认证的请求，JWT 请求跳过；
 * - route 去掉查询串，避免敏感参数进入审计表；
 * - S2：业务异常由全局过滤器在 finalize 之后处理，finalize 读到的 statusCode 仍是 200，
 *   必须在 catchError 先记真实状态码并防双写，否则审计把 404/429 记成 200；
 * - 审计写入失败不得影响业务响应，异常必须原样透传。
 */
const mockedContext = getApiKeyContext as jest.Mock;

function makeInterceptor() {
  const record = jest.fn();
  const interceptor = new ApiKeyUsageInterceptor({ record } as any);
  return { interceptor, record };
}

function makeContext(request: any, response: any = { statusCode: 200 }) {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as any;
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    originalUrl: '/api/files?page=1&token=secret',
    user: { id: 'u1' },
    ip: '203.0.113.9',
    ips: [],
    socket: { remoteAddress: '203.0.113.9' },
    headers: {},
    ...overrides,
  };
}

describe('ApiKeyUsageInterceptor（B-13）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedContext.mockReturnValue({ keyId: 'k1' });
  });

  it('JWT 请求（无 API Key 上下文）直接跳过，不写审计', async () => {
    mockedContext.mockReturnValue(null);
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => of({ ok: true }) } as any;

    const result = await firstValueFrom(interceptor.intercept(makeContext(makeRequest()), handler));

    expect(result).toEqual({ ok: true });
    expect(record).not.toHaveBeenCalled();
  });

  it('API Key 请求记录 method / route / ip / statusCode', async () => {
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => of({ ok: true }) } as any;

    await firstValueFrom(interceptor.intercept(makeContext(makeRequest(), { statusCode: 201 }), handler));

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      apiKeyId: 'k1',
      userId: 'u1',
      method: 'GET',
      route: '/api/files',
      statusCode: 201,
      ip: '203.0.113.9',
    }));
  });

  it('route 去掉查询串，敏感参数不进审计表', async () => {
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => of(null) } as any;

    await firstValueFrom(interceptor.intercept(makeContext(makeRequest()), handler));

    expect(record.mock.calls[0][0].route).toBe('/api/files');
    expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('secret');
  });

  it('S2：HttpException 在 catchError 记真实状态码，不被 finalize 的 200 覆盖', async () => {
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => throwError(() => new HttpException('不存在', HttpStatus.NOT_FOUND)) } as any;

    await expect(
      lastValueFrom(interceptor.intercept(makeContext(makeRequest(), { statusCode: 200 }), handler)),
    ).rejects.toBeInstanceOf(HttpException);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].statusCode).toBe(404);
  });

  it('非 HttpException 记 500，且只写一次', async () => {
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => throwError(() => new TypeError('内部细节')) } as any;

    await expect(
      lastValueFrom(interceptor.intercept(makeContext(makeRequest()), handler)),
    ).rejects.toBeInstanceOf(TypeError);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].statusCode).toBe(500);
  });

  it('异常原样透传，不被审计逻辑吞掉或替换', async () => {
    const { interceptor } = makeInterceptor();
    const original = new HttpException('冲突', HttpStatus.CONFLICT);
    const handler = { handle: () => throwError(() => original) } as any;

    await expect(
      lastValueFrom(interceptor.intercept(makeContext(makeRequest()), handler)),
    ).rejects.toBe(original);
  });

  it.each([409, 429])('业务状态码 %i 如实记录', async (status) => {
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => throwError(() => new HttpException('x', status)) } as any;

    await expect(
      lastValueFrom(interceptor.intercept(makeContext(makeRequest()), handler)),
    ).rejects.toBeInstanceOf(HttpException);

    expect(record.mock.calls[0][0].statusCode).toBe(status);
  });

  it('originalUrl 缺失时回退 url，且仍去掉查询串', async () => {
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => of(null) } as any;
    const request = makeRequest({ originalUrl: undefined, url: '/api/tags?a=1' });

    await firstValueFrom(interceptor.intercept(makeContext(request), handler));

    expect(record.mock.calls[0][0].route).toBe('/api/tags');
  });

  it('response.statusCode 非数字时回退 200', async () => {
    const { interceptor, record } = makeInterceptor();
    const handler = { handle: () => of(null) } as any;

    await firstValueFrom(interceptor.intercept(makeContext(makeRequest(), { statusCode: undefined }), handler));

    expect(record.mock.calls[0][0].statusCode).toBe(200);
  });
});
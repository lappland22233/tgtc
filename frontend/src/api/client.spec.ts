// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';

/**
 * L6 回归：`api/client.ts` 拦截器此前无直接测试。
 * 覆盖 XSRF 头注入（M1 后端已实现双重提交）、401 单次重定向、业务码拒绝与公开分享页豁免。
 */

const routerPush = vi.fn();
vi.mock('../router', () => ({
  default: { push: (...args: unknown[]) => routerPush(...args) },
  isValidRedirect: (path: string) => typeof path === 'string' && path.startsWith('/'),
}));

const authStore = { user: { id: 'u1' } as unknown, initialized: true };
vi.mock('../stores/auth', () => ({
  useAuthStore: () => authStore,
}));

vi.mock('../utils/message', () => ({
  default: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import client, { clearRedirectState, isRedirectInProgress } from './client';
import MessagePlugin from '../utils/message';
import { getUploadBudgetRetryAfterMs, isUploadBudgetBusy } from '../utils/error';

function clearCookies() {
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

let capturedConfig: InternalAxiosRequestConfig | undefined;

/** 让请求不触网：由测试自备 adapter。 */
function mockAdapter(handler: (config: InternalAxiosRequestConfig) => void = () => undefined) {
  client.defaults.adapter = async (config) => {
    capturedConfig = config as InternalAxiosRequestConfig;
    handler(config as InternalAxiosRequestConfig);
    return {
      data: { code: 0, message: 'ok', data: null },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
}

function mockAdapterRejecting(status: number, data: unknown, contentType = 'application/json') {
  client.defaults.adapter = async (config) => {
    capturedConfig = config as InternalAxiosRequestConfig;
    const error = Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      config,
      // 必须声明 JSON content-type：拦截器会把非 JSON 的 4xx/5xx 误判为 CDN 错误页文案
      // （Cloudflare HTML 错误页识别路径），真实 axios 响应同样带该头。
      response: { status, statusText: 'ERR', data, headers: { 'content-type': contentType }, config },
    });
    throw error;
  };
}

function headerValue(config: InternalAxiosRequestConfig | undefined, name: string): string | undefined {
  if (!config) return undefined;
  const headers = config.headers as unknown as { get?: (k: string) => unknown; [k: string]: unknown };
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value === undefined || value === null ? undefined : String(value);
  }
  const raw = headers[name] ?? headers[name.toLowerCase()];
  return raw === undefined ? undefined : String(raw);
}

describe('api/client 拦截器', () => {
  beforeEach(() => {
    clearCookies();
    capturedConfig = undefined;
    routerPush.mockClear();
    clearRedirectState();
    authStore.user = { id: 'u1' };
    window.history.pushState({}, '', '/files');
  });

  afterEach(() => {
    clearRedirectState();
    vi.useRealTimers();
  });

  describe('XSRF 双重提交头注入（M1）', () => {
    it('存在 XSRF-TOKEN Cookie 时注入 X-XSRF-TOKEN 头', async () => {
      document.cookie = 'XSRF-TOKEN=token-abc';
      mockAdapter();

      await client.get('/files');

      expect(headerValue(capturedConfig, 'X-XSRF-TOKEN')).toBe('token-abc');
    });

    it('不存在 Cookie 时不注入请求头（容错，不报错）', async () => {
      mockAdapter();

      await client.get('/files');

      expect(headerValue(capturedConfig, 'X-XSRF-TOKEN')).toBeUndefined();
    });

    it('调用方已显式设置时不被覆盖', async () => {
      document.cookie = 'XSRF-TOKEN=from-cookie';
      mockAdapter();

      await client.get('/files', { headers: { 'X-XSRF-TOKEN': 'explicit' } });

      expect(headerValue(capturedConfig, 'X-XSRF-TOKEN')).toBe('explicit');
    });
  });

  describe('401 重定向', () => {
    it('非公开页面 401 时清空登录态并跳转登录页（含 redirect）', async () => {
      vi.useFakeTimers();
      window.history.pushState({}, '', '/files?tag=1');
      mockAdapterRejecting(401, { code: 401, message: '未授权' });

      await expect(client.get('/files')).rejects.toBeTruthy();
      expect(isRedirectInProgress()).toBe(true);

      await vi.advanceTimersByTimeAsync(300);

      expect(authStore.user).toBeNull();
      expect(routerPush).toHaveBeenCalledTimes(1);
      expect(routerPush).toHaveBeenCalledWith(expect.objectContaining({ path: '/login' }));
      expect(isRedirectInProgress()).toBe(false);
    });

    it('公开分享页 401 不触发重定向（匿名访客不被踢到登录页）', async () => {
      vi.useFakeTimers();
      window.history.pushState({}, '', '/s/abc123');
      mockAdapterRejecting(401, { code: 401, message: '需要密码' });

      await expect(client.get('/s/abc123')).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(300);

      expect(routerPush).not.toHaveBeenCalled();
    });

    it('并发 401 只触发一次重定向', async () => {
      vi.useFakeTimers();
      mockAdapterRejecting(401, { code: 401, message: '未授权' });

      await Promise.allSettled([client.get('/a'), client.get('/b'), client.get('/c')]);
      await vi.advanceTimersByTimeAsync(300);

      expect(routerPush).toHaveBeenCalledTimes(1);
    });
  });

  describe('响应体业务码', () => {
    it('业务码非 0 时以 message 拒绝', async () => {
      client.defaults.adapter = async (config) => ({
        data: { code: 1001, message: '业务失败', data: null },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      });

      await expect(client.get('/x')).rejects.toThrow('业务失败');
    });

    it('无 code 字段的响应原样放行', async () => {
      client.defaults.adapter = async (config) => ({
        data: { raw: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      });

      const response = await client.get('/x');
      expect(response.data).toEqual({ raw: true });
    });
  });

  describe('严格小盘上传名额 429（UPLOAD_DISK_BUDGET_BUSY）', () => {
    it('不弹全局磁盘告警，且保留 response 供上传层排队等待', async () => {
      mockAdapterRejecting(429, {
        code: 429,
        errorCode: 'UPLOAD_DISK_BUDGET_BUSY',
        retryAfterMs: 5000,
        message: '服务器正在依次处理另一份大文件，本文件已自动排队，请保持页面打开',
      });

      const error = await client.post('/files/chunk/init', {}).catch((err: unknown) => err);

      // 排队不是基础设施故障：不得出现「存储空间不足」类全局提示
      expect(vi.mocked(MessagePlugin.error)).not.toHaveBeenCalled();
      expect((error as { response?: { status?: number } }).response?.status).toBe(429);
      expect(isUploadBudgetBusy(error)).toBe(true);
      expect(getUploadBudgetRetryAfterMs(error)).toBe(5000);
    });

    it('真实 507 磁盘不足仍弹全局告警', async () => {
      mockAdapterRejecting(507, { code: 507, message: '上传临时磁盘空间不足，请稍后重试' });

      await expect(client.get('/files')).rejects.toThrow('存储空间不足');

      expect(vi.mocked(MessagePlugin.error)).toHaveBeenCalled();
    });

    it('代理改写 content-type 时仍保留带业务码的排队响应（不得退化为 CDN 裸 Error）', async () => {
      mockAdapterRejecting(429, {
        code: 429,
        errorCode: 'UPLOAD_DISK_BUDGET_BUSY',
        retryAfterMs: 5000,
        message: '服务器正在依次处理另一份大文件，本文件已自动排队，请保持页面打开',
      }, 'text/html');

      const error = await client.post('/files/chunk/init', {}).catch((err: unknown) => err);

      expect(isUploadBudgetBusy(error)).toBe(true);
      expect(getUploadBudgetRetryAfterMs(error)).toBe(5000);
      expect((error as Error).message).not.toContain('CDN');
    });

    it('无业务码的非 JSON 错误页仍按 CDN 代理层文案转换', async () => {
      // 520 不在可用性归类（507/502/503/410）内，用于验证 CDN 转换分支未被上面的保留逻辑削掉
      mockAdapterRejecting(520, '<html><body>Unknown Error</body></html>', 'text/html');

      await expect(client.get('/files')).rejects.toThrow('源站暂时不可用');
    });
  });
});

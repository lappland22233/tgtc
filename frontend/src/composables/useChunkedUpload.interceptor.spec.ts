// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';

vi.mock('../router', () => ({
  default: { push: vi.fn() },
  isValidRedirect: () => true,
}));
vi.mock('../stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'u' } }) }));
vi.mock('../utils/message', () => ({
  default: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import api from '../api/client';
import { useChunkedUpload } from './useChunkedUpload';

const originalAdapter = api.defaults.adapter;

describe('分片上传与真实 API 错误拦截器', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    api.defaults.adapter = originalAdapter;
    vi.useRealTimers();
  });

  it.each([
    { stage: 'status', status: 502 },
    { stage: 'chunk', status: 503 },
  ])('$stage 收到包装的 $status 后重试并完成上传', async ({ stage, status }) => {
    let statusCalls = 0;
    let chunkCalls = 0;
    api.defaults.adapter = (async (config) => {
      const url = config.url ?? '';
      const isInitialStatus = url.endsWith('/status') && statusCalls++ === 0;
      const isChunk = url === '/files/chunk/u';
      if (isChunk) chunkCalls++;
      if ((stage === 'status' && isInitialStatus) || (stage === 'chunk' && isChunk && chunkCalls === 1)) {
        throw Object.assign(new Error(`HTTP ${status}`), {
          config,
          isAxiosError: true,
          response: { status, data: { code: status }, headers: { 'content-type': 'application/json' }, config },
        });
      }
      const data = url.endsWith('/init') ? { uploadId: 'u' }
        : url.endsWith('/status') ? (statusCalls === 1 && stage === 'chunk'
          ? { uploaded: [] }
          : stage === 'status' && statusCalls === 2 ? { uploaded: [] }
          : { mergeStatus: 'done', mergeResult: { id: 'f', originalName: 'a' } })
        : {};
      return { data: { code: 0, data }, status: 200, statusText: 'OK', headers: {}, config };
    }) as AxiosAdapter;

    const result = useChunkedUpload(1).uploadFile(new File(['x'], 'a'));
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toEqual({ id: 'f', originalName: 'a' });
    if (stage === 'status') expect(statusCalls).toBeGreaterThanOrEqual(3);
    else expect(chunkCalls).toBe(2);
  });
});

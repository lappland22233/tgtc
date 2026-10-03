// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { token: 'share-token' } }),
}));

// 与既有 share/预览类 spec 一致：TDesign 子路径的样式是裸 .css，Node 侧不可直接加载
vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import ShareView from './ShareView.vue';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function clearCookies() {
  document.cookie.split(';').forEach((entry) => {
    const name = entry.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
}

function mountShareView() {
  return mount(ShareView, {
    global: {
      stubs: {
        PasswordPrompt: {
          name: 'PasswordPrompt',
          emits: ['submit'],
          template: '<button class="pw-submit" @click="$emit(\'submit\', \'pwd\')" />',
        },
        FileShareCard: true,
        FolderShareBrowser: true,
      },
    },
  });
}

/**
 * SEC-102/SEC-103 关联回归：分享页密码校验走原生 fetch（不经 axios 实例），
 * 已登录访客（浏览器持有 access_token Cookie）必须携带 X-XSRF-TOKEN 头，
 * 否则被全局 CsrfGuard 以 403 拒绝、密码校验无法通过。
 */
describe('分享页密码校验的 CSRF 双重提交', () => {
  beforeEach(() => {
    clearCookies();
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('已签发 XSRF Cookie 时，verify 请求携带 X-XSRF-TOKEN 头', async () => {
    document.cookie = 'XSRF-TOKEN=token-abc';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { requiresPassword: true } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { verified: true } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { requiresPassword: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountShareView();
    await flushPromises();
    await wrapper.find('.pw-submit').trigger('click');
    await flushPromises();

    const verifyCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/verify'));
    expect(verifyCall).toBeTruthy();
    const options = verifyCall![1] as RequestInit;
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>)['X-XSRF-TOKEN']).toBe('token-abc');
  });

  it('匿名访客（无 XSRF Cookie）不注入该请求头，保持原有可访问性', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { requiresPassword: true } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { verified: true } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { requiresPassword: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mountShareView();
    await flushPromises();
    await wrapper.find('.pw-submit').trigger('click');
    await flushPromises();

    const verifyCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/verify'));
    expect(verifyCall).toBeTruthy();
    const options = verifyCall![1] as RequestInit;
    expect((options.headers as Record<string, string>)['X-XSRF-TOKEN']).toBeUndefined();
  });
});

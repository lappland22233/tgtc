// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import GDriveOAuthCallback from './GDriveOAuthCallback.vue';

const mockPush = vi.fn();
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('GDriveOAuthCallback.vue', () => {
  let mockOpener: { postMessage: ReturnType<typeof vi.fn>; closed: boolean };
  let mockBroadcastChannelPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpener = { postMessage: vi.fn(), closed: false };
    (window as any).opener = mockOpener;

    mockBroadcastChannelPost = vi.fn();
    (globalThis as any).BroadcastChannel = vi.fn().mockImplementation(() => ({
      postMessage: mockBroadcastChannelPost,
      close: vi.fn(),
    }));

    localStorage.clear();
  });

  it('URL 包含 code 时成功提取并广播通知，状态展示为成功', async () => {
    window.history.pushState({}, '', '/admin/storage-backends/gdrive-callback?code=mock_code_123&state=nonce_456');

    const wrapper = mount(GDriveOAuthCallback);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Google Drive 授权成功');
    expect(wrapper.text()).toContain('同步至 TGTC 管理后台');

    // 验证 postMessage 回传
    expect(mockOpener.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TGTC_GDRIVE_OAUTH_RESULT',
        status: 'success',
        code: 'mock_code_123',
        state: 'nonce_456',
      }),
      window.location.origin,
    );

    // 验证 BroadcastChannel 广播
    expect(mockBroadcastChannelPost).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TGTC_GDRIVE_OAUTH_RESULT',
        status: 'success',
        code: 'mock_code_123',
        state: 'nonce_456',
      }),
    );

    // 验证 localStorage 写入
    const stored = JSON.parse(localStorage.getItem('tgtc_gdrive_oauth_event') || '{}');
    expect(stored.type).toBe('TGTC_GDRIVE_OAUTH_RESULT');
    expect(stored.status).toBe('success');
    expect(stored.code).toBe('mock_code_123');
  });

  it('URL 包含 error 时展示错误信息并广播失败事件', async () => {
    window.history.pushState({}, '', '/admin/storage-backends/gdrive-callback?error=access_denied&error_description=User%20denied');

    const wrapper = mount(GDriveOAuthCallback);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Google Drive 授权失败');
    expect(wrapper.text()).toContain('User denied');

    expect(mockOpener.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TGTC_GDRIVE_OAUTH_RESULT',
        status: 'error',
        error: 'User denied',
      }),
      window.location.origin,
    );
  });

  it('点击返回存储管理按钮跳转到 /admin/storage-backends', async () => {
    window.history.pushState({}, '', '/admin/storage-backends/gdrive-callback?code=mock_code_123');

    const wrapper = mount(GDriveOAuthCallback);
    const returnBtn = wrapper.findAll('button').find((b) => b.text().includes('返回存储管理'));
    expect(returnBtn).toBeDefined();
    await returnBtn!.trigger('click');

    expect(mockPush).toHaveBeenCalledWith('/admin/storage-backends');
  });
});

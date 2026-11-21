// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    vi.stubGlobal('BroadcastChannel', class {
      postMessage = mockBroadcastChannelPost;
      close = vi.fn();
    });

    localStorage.clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('URL 包含 code 时成功提取并广播通知，状态展示为成功', async () => {
    window.history.pushState({}, '', '/admin/storage-backends/gdrive-callback?code=mock_code_123&state=nonce_456');

    const wrapper = mount(GDriveOAuthCallback);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('已收到 Google Drive 授权码');
    expect(wrapper.text()).toContain('以管理后台的兑换结果为准');

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
    expect(localStorage.getItem('tgtc_gdrive_oauth_event')).toBeNull();
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

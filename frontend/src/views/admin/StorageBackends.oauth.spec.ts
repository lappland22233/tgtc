// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import StorageBackends from './StorageBackends.vue';
import GDriveOAuthCallback from './GDriveOAuthCallback.vue';

const api = vi.hoisted(() => ({
  fetchGDriveAuthUrl: vi.fn().mockResolvedValue({ url: 'https://example.invalid/consent', state: 'issued-state' }),
  fetchStorageOverview: vi.fn().mockResolvedValue({
    accounts: [], scheduler: [], driverTypes: [], defaultBackend: 'telegram', gdriveOAuthConfigured: true,
  }),
  fetchGDriveOAuthClient: vi.fn().mockResolvedValue({ configured: true, clientId: 'test', redirectUri: null }),
  completeGDriveAuth: vi.fn().mockResolvedValue({ message: 'ok' }),
}));
vi.mock('@/api/storage-backends', () => api);
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('tdesign-vue-next/es/dialog', () => ({ DialogPlugin: { confirm: vi.fn() } }));
vi.mock('@/utils/message', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

describe('Google OAuth popup exchange', () => {
  it.each(['manual', 'automatic'])('uses the server-issued state once on the %s path', async mode => {
    vi.clearAllMocks();
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']});
    const opener = Object.getOwnPropertyDescriptor(window, 'opener');
    const originalPath = location.href;
    const popup = { closed: false, close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.stubGlobal('BroadcastChannel', class { postMessage() {} close() {} });
    Object.defineProperty(window, 'opener', {configurable: true, value: {
      closed: false,
      postMessage(data: unknown, target: string) {
        if (target === location.origin) {
          // Real browsers can deliver the same result on more than one transport.
          const event = () => new MessageEvent('message', {origin: target, data});
          window.dispatchEvent(event());
          window.dispatchEvent(event());
        }
      },
    }});
    const parent = shallowMount(StorageBackends);
    let callback: ReturnType<typeof shallowMount> | undefined;
    try {
      const wizard = (parent.vm as any).$.setupState;
      await wizard.openGDriveWizard();
      if (mode === 'automatic') await wizard.startOAuth();
      else {
        await wizard.buildManualAuthUrl();
        wizard.openAuthUrl();
      }
      const redirectUri = location.origin + '/admin/storage-backends/gdrive-callback';
      expect(wizard.currentNonce).toBe('issued-state');
      expect(api.fetchGDriveAuthUrl).toHaveBeenCalledWith(redirectUri, undefined);
      window.dispatchEvent(new MessageEvent('message', {
        origin: location.origin, data: {type: 'TGTC_GDRIVE_OAUTH_RESULT', status: 'success', code: 'other', state: 'other'},
      }));
      expect(api.completeGDriveAuth).not.toHaveBeenCalled();
      history.replaceState({}, '', redirectUri + '?code=local-code&state=issued-state');
      callback = shallowMount(GDriveOAuthCallback);
      await flushPromises();
      expect(api.completeGDriveAuth).toHaveBeenCalledTimes(1);
      expect(api.completeGDriveAuth).toHaveBeenCalledWith(expect.objectContaining({
        code: 'local-code', state: 'issued-state', redirectUri,
      }));
    } finally {
      callback?.unmount();
      parent.unmount();
      localStorage.clear();
      history.replaceState({}, '', originalPath);
      if (opener) Object.defineProperty(window, 'opener', opener);
      else Reflect.deleteProperty(window, 'opener');
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      openSpy.mockRestore();
    }
  });
});

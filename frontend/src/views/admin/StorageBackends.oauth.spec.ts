// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import StorageBackends from './StorageBackends.vue';
import GDriveOAuthCallback from './GDriveOAuthCallback.vue';
import MessagePlugin from '@/utils/message';

const confirmDialog = vi.hoisted(() => vi.fn((_opts: {onConfirm: () => Promise<void>}) => ({ destroy: vi.fn() })));

const api = vi.hoisted(() => ({
  fetchGDriveAuthUrl: vi.fn().mockResolvedValue({ url: 'https://example.invalid/consent', state: 'issued-state' }),
  fetchStorageOverview: vi.fn().mockResolvedValue({
    accounts: [], scheduler: [], driverTypes: [], defaultBackend: 'telegram', gdriveOAuthConfigured: true,
  }),
  fetchGDriveOAuthClient: vi.fn().mockResolvedValue({ configured: true, clientId: 'test', redirectUri: null }),
  setGDriveOAuthClient: vi.fn().mockResolvedValue({ message: 'saved' }),
  clearGDriveOAuthClient: vi.fn().mockResolvedValue({ message: 'cleared' }),
  updateStorageBackend: vi.fn().mockResolvedValue({ message: 'updated' }),
  createStorageBackend: vi.fn().mockResolvedValue({ message: 'created' }),
  rotateStorageCredential: vi.fn().mockResolvedValue({ message: 'rotated' }),
  revokeStorageBackend: vi.fn().mockResolvedValue({ message: 'revoked' }),
  setDefaultStorageBackend: vi.fn().mockResolvedValue({ message: 'saved' }),
  updateStorageSettings: vi.fn().mockImplementation(async settings => ({ ...settings, message: 'ok' })),
  testStorageBackend: vi.fn().mockResolvedValue({probe: {ok: true, latencyMs: 12}}),
  refreshStorageQuota: vi.fn().mockResolvedValue({message: 'updated'}),
  completeGDriveAuth: vi.fn().mockResolvedValue({ message: 'ok' }),
}));
vi.mock('@/api/storage-backends', () => api);
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('tdesign-vue-next/es/dialog', () => ({ DialogPlugin: { confirm: confirmDialog } }));
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

describe('storage administration contracts', () => {
  function mountAdmin() {
    vi.clearAllMocks();
    const wrapper = shallowMount(StorageBackends);
    return { wrapper, ui: (wrapper.vm as any).$.setupState };
  }

  it('keeps a stored client secret on metadata edits and preserves the form when a dependency prevents clearing', async () => {
    const { wrapper, ui } = mountAdmin();
    try {
      await ui.openOAuthClientDialog();
      expect(ui.gdrive.clientId).toBe('test');
      expect(ui.gdrive.clientSecret).toBe('');
      ui.gdrive.redirectUri = '';
      await ui.saveOAuthClientFromDialog();
      expect(api.setGDriveOAuthClient).toHaveBeenCalledWith('test', undefined, '');

      await ui.openOAuthClientDialog();
      api.clearGDriveOAuthClient.mockRejectedValueOnce(new Error('existing account'));
      ui.handleClearOAuthClient();
      expect(api.clearGDriveOAuthClient).not.toHaveBeenCalled();
      await confirmDialog.mock.lastCall![0].onConfirm();
      expect(ui.oauthClientModalVisible).toBe(true);
      expect(ui.gdrive.clientId).toBe('test');
      expect(MessagePlugin.error).toHaveBeenCalled();

      ui.handleClearOAuthClient();
      await confirmDialog.mock.lastCall![0].onConfirm();
      expect(ui.gdrive.clientId).toBe('');
      expect(ui.oauthClientModalVisible).toBe(false);

      await ui.openGDriveWizard();
      ui.gdrive.clientSecret = 'replacement';
      await ui.saveOAuthClient();
      expect(api.setGDriveOAuthClient).toHaveBeenLastCalledWith('test', 'replacement', ui.gdrive.redirectUri);
      expect(ui.gdrive.clientSecret).toBe('');
      expect(ui.showClientConfig).toBe(false);
    } finally { wrapper.unmount(); }
  });

  it('uses account-bound issuance for a rotation and rejects a callback for a different flow', async () => {
    const { wrapper, ui } = mountAdmin();
    try {
      const account = { id: 'drive-a', type: 'gdrive', name: 'Archive' };
      ui.openRotate(account);
      await ui.saveRotate();
      await flushPromises();
      await ui.buildManualAuthUrl();
      const redirect = ui.gdrive.redirectUri;
      expect(api.fetchGDriveAuthUrl).toHaveBeenCalledWith(redirect, 'drive-a');
      ui.gdrive.code = redirect + '?code=other&state=wrong';
      await ui.completeAuth();
      expect(ui.gdrive.code).toBe('');
      expect(api.completeGDriveAuth).not.toHaveBeenCalled();
      ui.gdrive.code = redirect + '?code=match&state=issued-state';
      await ui.completeAuth();
      expect(api.completeGDriveAuth).toHaveBeenCalledWith({
        accountId: account.id, name: account.name, redirectUri: redirect, code: 'match', state: 'issued-state',
      });
      expect(api.rotateStorageCredential).not.toHaveBeenCalled();
    } finally { wrapper.unmount(); }
  });

  it('cleans up a denied broadcast and allows the next flow to finish through storage events', async () => {
    const channels: { onmessage?: (event: {data: unknown}) => void; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('BroadcastChannel', class {
      close = vi.fn();
      constructor() { channels.push(this); }
    });
    const { wrapper, ui } = mountAdmin();
    try {
      await ui.openGDriveWizard();
      await ui.buildManualAuthUrl();
      channels[0].onmessage!({ data: {
        type: 'TGTC_GDRIVE_OAUTH_RESULT', status: 'error', state: 'issued-state', error: 'access_denied',
      } });
      expect(channels[0].close).toHaveBeenCalledOnce();
      expect(ui.currentNonce).toBe('');
      expect(api.completeGDriveAuth).not.toHaveBeenCalled();
      api.fetchGDriveAuthUrl.mockResolvedValueOnce({url: 'https://example.invalid/new', state: 'fresh'});
      await ui.buildManualAuthUrl();
      const notifyStorage = (state: string) => window.dispatchEvent(new StorageEvent('storage', {
        key: 'tgtc_gdrive_oauth_event', newValue: JSON.stringify({
          type: 'TGTC_GDRIVE_OAUTH_RESULT', status: 'success', state, code: 'local-result',
        }),
      }));
      notifyStorage('issued-state');
      expect(api.completeGDriveAuth).not.toHaveBeenCalled();
      notifyStorage('fresh');
      await flushPromises();
      expect(api.completeGDriveAuth).toHaveBeenCalledTimes(1);
      expect(api.completeGDriveAuth).toHaveBeenCalledWith(expect.objectContaining({state: 'fresh', code: 'local-result'}));
      expect(channels[1].close).toHaveBeenCalledOnce();
    } finally {
      wrapper.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('uses metadata updates for Drive edits and separate credential requests for WebDAV creation and rotation', async () => {
    const { wrapper, ui } = mountAdmin();
    try {
      ui.openCreate();
      Object.assign(ui.form, { type: 'gdrive', name: 'drive' });
      await ui.saveAccount();
      expect(api.createStorageBackend).not.toHaveBeenCalled();
      Object.assign(ui.form, { type: 'webdav', name: 'dav' });
      Object.assign(ui.form.webdav, { url: 'https://example.invalid/dav', rootPath: '/backup' });
      Object.assign(ui.form.credential, { username: 'writer', password: 'initial' });
      await ui.saveAccount();
      expect(api.createStorageBackend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'webdav', config: { url: 'https://example.invalid/dav', rootPath: '/backup' },
        credential: { username: 'writer', password: 'initial' },
      }));
      ui.openRotate({id: 'dav-a', type: 'webdav'});
      Object.assign(ui.rotateForm, {username: 'writer', password: 'new'});
      await ui.saveRotate();
      expect(api.rotateStorageCredential).toHaveBeenCalledWith('dav-a', {username: 'writer', password: 'new'});

      const row = { id: 'g-a', type: 'gdrive', name: 'drive', weight: 3, maxInflight: 1 };
      ui.openEdit(row);
      ui.form.name = 'new name';
      await ui.saveAccount();
      expect(api.updateStorageBackend).toHaveBeenCalledWith(row.id, {
        name: 'new name', weight: 3, maxInflight: 1, note: '',
      });
      await ui.toggleEnabled(row, false);
      expect(api.updateStorageBackend).toHaveBeenLastCalledWith(row.id, { enabled: false });
      ui.revokeAccount(row);
      expect(api.revokeStorageBackend).not.toHaveBeenCalled();
      await confirmDialog.mock.lastCall![0].onConfirm();
      expect(api.revokeStorageBackend).toHaveBeenCalledWith(row.id);
    } finally { wrapper.unmount(); }
  });

  it('applies server settings, runs a probe for the selected account, and refreshes quota', async () => {
    const { wrapper, ui } = mountAdmin();
    try {
      await flushPromises();
      ui.defaultBackendDraft = 'gdrive';
      await ui.saveDefaultBackend();
      expect(api.setDefaultStorageBackend).toHaveBeenCalledWith('gdrive');
      await ui.onGDriveCacheModeChange(true);
      expect(ui.overview.gdriveCacheMode).toBe(true);
      ui.gdriveChunkSizeDraft = 32;
      await ui.saveGDriveChunkSize();
      expect(ui.overview.gdriveChunkSizeMb).toBe(32);
      await ui.testAccount({id: 'drive-one'});
      await ui.refreshQuota({id: 'drive-two'});
      expect(api.testStorageBackend).toHaveBeenCalledWith('drive-one');
      expect(api.refreshStorageQuota).toHaveBeenCalledWith('drive-two');
      expect(ui.rowBusy).toBeNull();
    } finally { wrapper.unmount(); }
  });
});

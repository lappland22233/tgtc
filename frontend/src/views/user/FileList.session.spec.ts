// @vitest-environment jsdom
import { shallowMount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileList from './FileList.vue';
import FileListDesktopRows from './FileListDesktopRows.vue';
import { useAuthStore } from '@/stores/auth';
import { useDownloadsStore } from '@/stores/downloads';
import { useMediaPlaybackStore } from '@/stores/mediaPlayback';
import client from '@/api/client';
import type { FileItem } from '@/types/file';
import type { User } from '@/types/user';

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/api/client', () => ({ default: { get: vi.fn(), post: vi.fn() }, clearRedirectState: vi.fn() }));
vi.mock('tdesign-vue-next/es/dialog', () => ({ DialogPlugin: { confirm: vi.fn() } }));
vi.mock('@/utils/message', () => ({ default: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const owner: User = {
  id: 'first-user', email: 'first@example.invalid', emailVerified: true, role: 'user',
  isBanned: false, lastLoginAt: null, createdAt: '2026-01-01T00:00:00Z',
};
const video: FileItem = {
  id: 'video', filename: 'clip.mp4', originalName: 'clip.mp4', mimeType: 'video/mp4', size: 64,
  uploadVersion: 2, accessType: 'private', maxAccessCount: 0, currentAccessCount: 0, expiresIn: null,
  expiresStartAt: null, hasPassword: false, createdAt: owner.createdAt, uploader: null,
  isDeleted: false, deletedByAdmin: false, deleteScheduledAt: null, deleteRequestedAt: null,
};
const hidden: FileItem = { ...video, id: 'processing', status: 'processing' };

describe('file list session ownership', () => {
  let wrapper: ReturnType<typeof shallowMount> | undefined;
  beforeEach(() => {
    setActivePinia(createPinia());
    useAuthStore().user = { ...owner };
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.mocked(client.get).mockImplementation(async (url) => {
      const responses: Record<string, unknown> = {
        '/files': { files: [video, hidden], total: 2 }, '/folders/tree': { tree: [] }, '/tags': { tags: [] },
      };
      if (!(url in responses)) throw new Error('Unexpected GET ' + url);
      return { data: { data: responses[url] } };
    });
  });
  afterEach(() => {
    wrapper?.unmount();
    useDownloadsStore().stopAll();
    useAuthStore().disposeAuthListeners();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('drops a pending download from the previous login even when its ticket arrives after the switch', async () => {
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let finish!: (value: { data: { data: { taskId: string; status: string; downloadUrl: string } } }) => void;
    vi.mocked(client.post).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    wrapper = shallowMount(FileList);
    await flushPromises();
    const rows = wrapper.getComponent(FileListDesktopRows);
    expect(rows.props('thumbnailContext')).toBe('u:first-user');
    rows.vm.$emit('download', video);
    expect(client.post).toHaveBeenCalledWith('/files/video/download-tasks', {});
    useAuthStore().user = { ...owner, id: 'next-user' };
    finish({ data: { data: {
      taskId: 'old-task', status: 'streamable', downloadUrl: '/api/files/video/download?taskTicket=old',
    } } });
    await flushPromises();
    expect(rows.props('thumbnailContext')).toBe('u:next-user');
    expect(useDownloadsStore().jobs).toEqual([]);
    expect(downloadClick).not.toHaveBeenCalled();
  });

  it('assigns previews to the signed-in user and omits processing media from the playlist', async () => {
    wrapper = shallowMount(FileList);
    await flushPromises();
    const rows = wrapper.getComponent(FileListDesktopRows);
    rows.vm.$emit('preview', hidden);
    const media = useMediaPlaybackStore();
    expect(media.session).toBeNull();
    rows.vm.$emit('preview', video);
    expect(media.session).toMatchObject({
      context: { type: 'user', userId: owner.id },
      item: { id: video.id, contentVersion: 2, src: '/api/files/video/preview' },
      playlist: [{ id: video.id }], playlistIndex: 0,
    });
  });
});

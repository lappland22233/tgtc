// @vitest-environment jsdom
import { reactive } from 'vue';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileList from './FileList.vue';
import FileListBatchActions from './FileListBatchActions.vue';
import type { Folder } from '@/stores/folders';
import FileListDesktopRows from './FileListDesktopRows.vue';
import FileWorkspaceDetails from './FileWorkspaceDetails.vue';
import FileWorkspaceDirectory from './FileWorkspaceDirectory.vue';
import { useAuthStore } from '@/stores/auth';
import { useDownloadsStore } from '@/stores/downloads';
import { useMediaPlaybackStore } from '@/stores/mediaPlayback';
import client from '@/api/client';
import type { FileItem } from '@/types/file';
import type { User } from '@/types/user';

const route = reactive({ query: {} as Record<string, string> });
const navigate = (location: { query: Record<string, string> }) => { route.query = location.query; };
vi.mock('vue-router', () => ({
  useRoute: () => route, useRouter: () => ({ replace: navigate, push: navigate }),
}));
vi.mock('@/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, clearRedirectState: vi.fn() }));
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
const folder: Folder = {
  id: 'archive', name: 'Archive', ownerId: owner.id, parentId: null, isDeleted: false,
  createdAt: owner.createdAt, updatedAt: owner.createdAt,
};
const photo: FileItem = { ...video, id: 'photo', originalName: 'photo.png', mimeType: 'image/png', accessType: 'public' };
const hidden: FileItem = { ...video, id: 'processing', status: 'processing' };

describe('file list session ownership', () => {
  let wrapper: ReturnType<typeof shallowMount> | undefined;
  beforeEach(() => {
    route.query = {};
    vi.clearAllMocks();
    setActivePinia(createPinia());
    useAuthStore().user = { ...owner };
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.mocked(client.get).mockImplementation(async (url) => {
      const responses: Record<string, unknown> = {
        '/files': { files: [video, hidden, photo], total: 3 }, '/folders/tree': { tree: [folder] },
        '/folders/breadcrumb': { breadcrumb: [folder] }, '/tags': { tags: [] },
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

  it.each([1024, 390])('observes pagination and releases the observer at %i px', async (width) => {
    vi.stubGlobal('innerWidth', width);
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      observe = observe;
      disconnect = disconnect;
    });
    wrapper = shallowMount(FileList);
    await flushPromises();
    expect(observe).toHaveBeenCalledWith(wrapper.get('.os-sentinel').element);
    wrapper.unmount();
    wrapper = undefined;
    expect(disconnect).toHaveBeenCalled();
  });

  it('keeps details independent of batch selection and clears them on folder navigation', async () => {
    vi.stubGlobal('innerWidth', 1024);
    wrapper = shallowMount(FileList);
    await flushPromises();
    const rows = wrapper.getComponent(FileListDesktopRows);
    rows.vm.$emit('file-select', photo);
    rows.vm.$emit('inspect', video);
    await flushPromises();
    expect(rows.props('selectedIds')).toEqual([photo.id]);
    expect(wrapper.getComponent(FileWorkspaceDetails).props('file')).toMatchObject({ id: video.id });

    wrapper.getComponent(FileWorkspaceDirectory).vm.$emit('navigate', folder.id);
    await flushPromises();
    expect(route.query.folder).toBe(folder.id);
    expect(wrapper.findComponent(FileWorkspaceDetails).exists()).toBe(false);
    expect(wrapper.getComponent(FileListDesktopRows).props('selectedIds')).toEqual([]);
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

  async function openPage() {
    wrapper = shallowMount(FileList, { global: { stubs: {
      FileListDesktopRows: false, FileContextMenu: false, teleport: true,
      't-icon': true, 't-tag': true, 't-loading': true,
      't-dialog': {
        props: ['visible', 'header'], emits: ['confirm'],
        template: `<section v-if="visible" role="dialog" :aria-label="header"><slot/><button @click="$emit('confirm')">确认</button></section>`,
      },
      't-input': {
        props: ['modelValue'], emits: ['update:modelValue'],
        template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
      },
      't-input-number': {
        props: ['modelValue'], emits: ['update:modelValue'],
        template: `<input type="number" :value="modelValue" @input="$emit('update:modelValue', Number($event.target.value))" />`,
      },
      't-select': {
        props: ['modelValue', 'options'], emits: ['update:modelValue'],
        template: `<select :value="modelValue" @change="$emit('update:modelValue', Number($event.target.value))"><option v-for="o in options" :key="o.label" :value="o.value">{{ o.label }}</option></select>`,
      },
      't-checkbox': {
        props: ['checked', 'disabled'], emits: ['change'],
        template: `<input type="checkbox" :checked="checked" :disabled="disabled" @change="$emit('change')" />`,
      },
    } } });
    await flushPromises();
    return wrapper;
  }

  async function menuAction(selector: string, label: string) {
    await wrapper!.get(selector).trigger('contextmenu', { clientX: 20, clientY: 40 });
    const item = wrapper!.findAll('[role="menuitem"]').find((entry) => entry.text() === label);
    expect(item, `menu should offer ${label}`).toBeDefined();
    await item!.trigger('click');
    await flushPromises();
  }

  const fileRow = '[aria-label="下载 clip.mp4"]';
  it('opens sharing and download-link dialogs for the clicked file and pastes its copy into the current folder', async () => {
    const page = await openPage();
    await menuAction(fileRow, '分享');
    const share = page.getComponent({ name: 'CreateShareDialog' });
    expect(share.props()).toMatchObject({ visible: true, targetType: 'file', targetId: video.id, targetName: video.originalName });
    share.vm.$emit('update:visible', false);
    await menuAction(fileRow, '获取下载链接…');
    const link = page.getComponent({ name: 'DownloadLinkDialog' });
    expect(link.props()).toMatchObject({ visible: true, fileId: video.id, fileName: video.originalName });
    link.vm.$emit('update:visible', false);
    await menuAction(fileRow, '复制');
    await page.get('.os-folder').trigger('dblclick');
    await flushPromises();
    expect(route.query.folder).toBe(folder.id);
    vi.mocked(client.post).mockResolvedValueOnce({ data: { data: { id: 'copy' } } });
    await menuAction('.os-list', '粘贴（1 个文件）');
    expect(client.post).toHaveBeenCalledWith('/files/video/copy', { folderId: folder.id });
    await page.get('.os-list').trigger('contextmenu');
    expect(page.findAll('[role="menuitem"]').some(item => item.text().startsWith('粘贴'))).toBe(false);
  });

  it('keeps folder share, rename and move targets distinct and inserts a newly created folder into the list', async () => {
    const page = await openPage();
    await menuAction('.os-folder', '分享');
    const share = page.getComponent({ name: 'CreateShareDialog' });
    expect(share.props()).toMatchObject({ visible: true, targetType: 'folder', targetId: folder.id });
    share.vm.$emit('update:visible', false);
    await menuAction('.os-folder', '重命名');
    const rename = page.getComponent({ name: 'FolderRenameDialog' });
    expect(rename.props()).toMatchObject({ visible: true, folder });
    rename.vm.$emit('update:visible', false);
    await menuAction('.os-folder', '移动到...');
    const move = page.getComponent({ name: 'FolderMoveDialog' });
    expect(move.props()).toMatchObject({
      visible: true, targetKind: 'folder', targetIds: [folder.id], disabledIds: [folder.id],
    });
    move.vm.$emit('update:visible', false);
    await menuAction('.os-list', '新建文件夹');
    const create = page.getComponent({ name: 'FolderCreateDialog' });
    expect(create.props()).toMatchObject({ visible: true, parentId: null });
    create.vm.$emit('created', { ...folder, id: 'new-folder', name: 'New folder' });
    await flushPromises();
    expect(page.findAll('.os-folder').map(row => row.text())).toEqual(expect.arrayContaining([expect.stringContaining('New folder')]));
  });

  it.each([
    ['设置访问密码', '设置访问密码', 'input', 'new-password', 'password', { password: 'new-password' }],
    ['访问次数限制…', '设置访问次数限制', 'input', '12', 'access-count', { maxAccessCount: 12 }],
    ['限时访问…', '设置限时访问', 'select', '1', 'expires', { expiresIn: 1 }],
  ] as const)('saves %s from the menu against the clicked file', async (action, title, control, value, endpoint, payload) => {
    const page = await openPage();
    await menuAction(fileRow, action);
    const dialog = page.get(`[role="dialog"][aria-label="${title}"]`);
    await dialog.get(control).setValue(value);
    await dialog.get('button').trigger('click');
    await flushPromises();
    expect(client.put).toHaveBeenCalledWith(`/files/video/${endpoint}`, payload);
    expect(page.find(`[role="dialog"][aria-label="${title}"]`).exists()).toBe(false);
  });

  it('only selects actionable files, moves their IDs and clears the selection after moving', async () => {
    const page = await openPage();
    const batch = page.getComponent(FileListBatchActions);
    const rows = page.getComponent(FileListDesktopRows);
    await page.get(`${fileRow} input[type="checkbox"]`).setValue(true);
    expect(rows.props('isIndeterminate')).toBe(true);
    await page.get('.os-head input[type="checkbox"]').setValue(true);
    expect(rows.props('selectedIds')).toEqual([video.id, photo.id]);
    expect(batch.props('selectedCount')).toBe(2);
    batch.vm.$emit('move');
    await flushPromises();
    const move = page.getComponent({ name: 'FolderMoveDialog' });
    expect(move.props()).toMatchObject({ visible: true, targetKind: 'file', targetIds: [video.id, photo.id], disabledIds: [] });
    move.vm.$emit('moved');
    await flushPromises();
    expect(batch.props('selectedCount')).toBe(0);
  });
});

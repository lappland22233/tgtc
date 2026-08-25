// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import FolderShareBrowser from './FolderShareBrowser.vue';
import MessagePlugin from '@/utils/message';

vi.mock('@/utils/message', () => ({
  default: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/components/ThumbnailImg.vue', () => ({
  default: { name: 'ThumbnailImg', template: '<span class="thumbnail-stub" />' },
}));

const root = { id: 'root', name: '根目录' };
const child = { id: 'child', name: '子目录' };
const file = (id: string) => ({
  id,
  name: `${id}.txt`,
  size: 1,
  mimeType: 'text/plain',
  createdAt: '2025-01-01T00:00:00.000Z',
  downloadUrl: `/download/${id}`,
});
const contents = (files = [file('root-file')], subfolders = [child]) => ({ subfolders, files });
const breadcrumb = [root];

function response(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(data) } as unknown as Response;
}
function payload(folder: typeof root, data = contents([], [])) {
  return [
    response({ code: 0, data }),
    response({ code: 0, data: { breadcrumb: [root, folder] } }),
  ];
}
function mountBrowser() {
  return mount(FolderShareBrowser, {
    props: { token: 'token', rootFolder: root, initialContents: contents(), initialBreadcrumb: breadcrumb },
    global: {
      stubs: {
        't-loading': { template: '<span />' },
        't-button': { emits: ['click'], template: '<button @click="$emit(\'click\')"><slot /></button>' },
      },
    },
  });
}

describe('FolderShareBrowser 目录状态提交', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('内容或 breadcrumb 失败时不会半更新目录状态', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, data: contents([], []) }))
      .mockResolvedValueOnce(response({ code: 500, message: 'breadcrumb failed' }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(MessagePlugin.error).toHaveBeenCalledWith('breadcrumb failed'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.breadcrumb-item.active').text()).toContain('根目录');
    expect(wrapper.text()).toContain('root-file.txt');
    expect(wrapper.text()).toContain('子目录');
    expect(wrapper.find('.back-to-parent').exists()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('成功进入子目录后可返回父级并恢复父级内容', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, data: contents([], []) }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }))
      .mockResolvedValueOnce(response({ code: 0, data: contents([file('root-file')], [child]) }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('.breadcrumb-item.active').text()).toContain('子目录'));
    expect(wrapper.text()).toContain('子目录');
    expect(wrapper.text()).not.toContain('root-file.txt');

    await wrapper.find('.back-to-parent button').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('.breadcrumb-item.active').text()).toContain('根目录'));
    expect(wrapper.text()).toContain('root-file.txt');
    expect(wrapper.text()).not.toContain('child-file.txt');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });
});

// Keep the helper close to the tests so response construction remains explicit.
void payload;

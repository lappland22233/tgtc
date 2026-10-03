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
/** 带分页信息的目录内容响应体（与后端 { pagination: { page, limit, total, hasMore } } 契约一致） */
const paginatedContents = (
  files: ReturnType<typeof file>[],
  pagination: { page: number; limit: number; total: number; hasMore: boolean },
  subfolders: (typeof child)[] = [],
) => ({ subfolders, files, pagination });
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

  it('子目录请求返回 401 时触发 credential-expired', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ message: '凭据已失效' }, false, 401))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.emitted('credential-expired')).toHaveLength(1));

    expect(MessagePlugin.error).not.toHaveBeenCalled();
    expect(wrapper.find('.breadcrumb-item.active').text()).toContain('根目录');
    expect(wrapper.text()).toContain('root-file.txt');
    vi.unstubAllGlobals();
  });

  it('子目录请求返回 403 时保留当前目录并显示后端消息，不触发 credential-expired', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: 403, message: '没有访问该子目录的权限' }, false, 403))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(MessagePlugin.error).toHaveBeenCalledWith('没有访问该子目录的权限'));

    expect(wrapper.emitted('credential-expired')).toBeUndefined();
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

describe('FolderShareBrowser 目录分页', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('打开子目录时只请求第一页（page=1&limit=100）', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents([file('child-1')], { page: 1, limit: 100, total: 1, hasMore: false }),
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('child-1.txt'));

    const contentsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/contents'));
    expect(contentsCalls).toHaveLength(1);
    expect(String(contentsCalls[0][0])).toBe('/api/s/token/folder/child/contents?page=1&limit=100');
    // 全部加载完成（total = 已加载数）时不显示分页提示
    expect(wrapper.find('.load-more-row').exists()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('点击「加载更多」请求第二页且条目追加而非替换', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents([file('child-1')], { page: 1, limit: 100, total: 2, hasMore: true }),
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents([file('child-2')], { page: 2, limit: 100, total: 2, hasMore: false }),
      }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('child-1.txt'));

    await wrapper.find('.load-more-row button').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('child-2.txt'));

    expect(String(fetchMock.mock.calls[2][0])).toBe('/api/s/token/folder/child/contents?page=2&limit=100');
    // 第一页条目保留（追加而非替换）
    expect(wrapper.text()).toContain('child-1.txt');
    // hasMore=false 后不再显示「加载更多」
    expect(wrapper.find('.load-more-row').exists()).toBe(false);
    vi.unstubAllGlobals();
  });

  it('加载更多进行中按钮禁用且重复点击不会重复请求', async () => {
    let resolveSecondPage!: (value: Response) => void;
    const secondPagePromise = new Promise<Response>((resolve) => { resolveSecondPage = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents([file('child-1')], { page: 1, limit: 100, total: 2, hasMore: true }),
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }))
      .mockReturnValueOnce(secondPagePromise);
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('.load-more-row button').exists()).toBe(true));

    await wrapper.find('.load-more-row button').trigger('click');
    expect(wrapper.find('.load-more-row button').attributes('disabled')).toBeDefined();
    // 加载中再次点击：被禁用/守卫拦截，不产生新的请求
    await wrapper.find('.load-more-row button').trigger('click');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    resolveSecondPage(response({
      code: 0,
      data: paginatedContents([file('child-2')], { page: 2, limit: 100, total: 2, hasMore: false }),
    }));
    await vi.waitFor(() => expect(wrapper.text()).toContain('child-2.txt'));
    vi.unstubAllGlobals();
  });

  it('目录切换后分页状态与已加载条目重置，再次进入从第一页开始', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents([file('child-1')], { page: 1, limit: 100, total: 2, hasMore: true }),
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents([file('child-2')], { page: 2, limit: 100, total: 2, hasMore: false }),
      }))
      .mockResolvedValueOnce(response({ code: 0, data: contents([file('root-file')], [child]) }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root] } }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents([file('child-1')], { page: 1, limit: 100, total: 2, hasMore: true }),
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('child-1.txt'));
    await wrapper.find('.load-more-row button').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('child-2.txt'));

    // 返回上级：根目录内容与分页状态整体替换
    await wrapper.find('.back-to-parent button').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('root-file.txt'));
    expect(wrapper.text()).not.toContain('child-1.txt');

    // 再次进入子目录：必须重新从第一页请求，上一轮加载的第二页条目不残留
    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('child-1.txt'));
    expect(String(fetchMock.mock.calls[5][0])).toBe('/api/s/token/folder/child/contents?page=1&limit=100');
    expect(wrapper.text()).not.toContain('child-2.txt');
    vi.unstubAllGlobals();
  });

  it('仍有未加载文件时显示截断提示与总数', async () => {
    const hundredFiles = Array.from({ length: 100 }, (_, index) => file(`page1-${index}`));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        code: 0,
        data: paginatedContents(hundredFiles, { page: 1, limit: 100, total: 342, hasMore: true }),
      }))
      .mockResolvedValueOnce(response({ code: 0, data: { breadcrumb: [root, child] } }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountBrowser();

    await wrapper.find('button[aria-label="打开文件夹 子目录"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('.load-more-hint').exists()).toBe(true));

    expect(wrapper.find('.load-more-hint').text()).toBe('已加载 100 / 共 342 个文件');
    expect(wrapper.find('.load-more-row button').exists()).toBe(true);
    vi.unstubAllGlobals();
  });
});

// Keep the helper close to the tests so response construction remains explicit.
void payload;

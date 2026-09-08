import { describe, expect, it, vi, beforeEach } from 'vitest';
import { nextTick, effectScope } from 'vue';
import { useFileListQuery } from './useFileListQuery';

/**
 * 搜索修复回归：关键词快照与目录过滤语义。
 * 覆盖提交/未提交输入、分页快照、清空恢复和乱序响应（代际隔离）。
 */

function createStores() {
  const files = [] as any[];
  const fileStore = {
    files,
    total: 0,
    fetchFilesPage: vi.fn(async (_page: number, _limit: number, keyword?: string) => {
      const all = keyword
        ? [{ id: `f-${keyword}`, originalName: `匹配-${keyword}.txt` }]
        : [{ id: 'f-1', originalName: 'a.txt' }, { id: 'f-2', originalName: 'b.txt' }];
      return { files: all, total: all.length };
    }),
    replaceFiles: vi.fn((list: any[]) => { files.splice(0, files.length, ...list); }),
    appendFiles: vi.fn((list: any[]) => { files.push(...list); }),
  };
  const folderStore = {
    currentFolderId: null as string | null,
    tree: [
      { id: 'fd-1', name: '项目资料', isDeleted: false, children: [] },
      { id: 'fd-2', name: '临时目录', isDeleted: false, children: [] },
    ],
    breadcrumb: [],
  };
  return { fileStore, folderStore };
}

function createRouteQuery(query: Record<string, string> = {}) {
  return { query };
}

/** 提取 fetchFilesPage 最后一次调用的第 N 个参数（0 基） */
function lastArg(stores: ReturnType<typeof createStores>, index: number) {
  const calls = (stores.fileStore.fetchFilesPage as any).mock.calls;
  return calls[calls.length - 1][index];
}

describe('useFileListQuery 搜索快照（下载与搜索修复 A 阶段）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('handleSearch 提交后才把输入框值提升为已生效关键词', async () => {
    const scope = effectScope();
    const stores = createStores();
    const route = createRouteQuery();
    const router = { replace: vi.fn() };
    const q = scope.run(() => useFileListQuery({ fileStore: stores.fileStore as any, folderStore: stores.folderStore as any, route: route as any, router: router as any }))!;

    // 初次加载
    await q.loadInitialFiles();
    await nextTick();

    // 只输入未提交：分页请求仍使用空关键词
    q.search.value = '项目';
    await q.loadMoreFiles();
    expect(lastArg(stores, 2)).toBeUndefined();

    // 提交后：请求携带关键词，展示快照同步切换
    q.handleSearch();
    await nextTick();
    expect(q.submittedSearch.value).toBe('项目');
    expect(q.displayedSearch.value).toBe('项目');
    expect(lastArg(stores, 2)).toBe('项目');
    scope.stop();
  });

  it('handleClearSearch 清空关键词并恢复无关键词查询', async () => {
    const scope = effectScope();
    const stores = createStores();
    const q = scope.run(() => useFileListQuery({ fileStore: stores.fileStore as any, folderStore: stores.folderStore as any, route: createRouteQuery() as any, router: { replace: vi.fn() } as any }))!;
    await q.loadInitialFiles();

    q.search.value = '临时';
    q.handleSearch();
    await nextTick();
    expect(q.displayedSearch.value).toBe('临时');

    q.handleClearSearch();
    await nextTick();
    expect(q.submittedSearch.value).toBe('');
    expect(q.displayedSearch.value).toBe('');
    expect(lastArg(stores, 2)).toBeUndefined();
    scope.stop();
  });

  it('旧搜索响应迟于新搜索返回时，不覆盖新关键词的展示快照（代际隔离）', async () => {
    const scope = effectScope();
    const stores = createStores();
    let resolveFirst: (v: { files: any[]; total: number }) => void = () => {};
    stores.fileStore.fetchFilesPage.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));

    const q = scope.run(() => useFileListQuery({ fileStore: stores.fileStore as any, folderStore: stores.folderStore as any, route: createRouteQuery() as any, router: { replace: vi.fn() } as any }))!;
    await q.loadInitialFiles();

    // 搜索 A：响应被挂起
    q.search.value = 'A';
    const searchA = q.handleSearch();
    await nextTick();

    // 搜索 B：快速返回
    q.search.value = 'B';
    q.handleSearch();
    await nextTick();
    expect(q.displayedSearch.value).toBe('B');

    // A 迟到返回：不得把展示快照切回 A
    resolveFirst({ files: [{ id: 'stale', originalName: 'stale' }], total: 1 });
    await searchA;
    await nextTick();
    expect(q.displayedSearch.value).toBe('B');
    scope.stop();
  });
});

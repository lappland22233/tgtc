import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder } from '../stores/folders';

const { api, folderStore } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  folderStore: {
    tree: [] as Folder[],
    breadcrumb: [] as Folder[],
    fetchTree: vi.fn(),
    findInTree: vi.fn(),
    insertIntoTree: vi.fn(),
  },
}));

vi.mock('../api/client', () => ({ default: api }));
vi.mock('../stores/folders', () => ({
  useFolderStore: () => folderStore,
}));

import { prepareDirectories } from './folder-resolver';

function parsed(path: string) {
  const segments = path.split('/');
  return [{
    file: new File(['content'], segments[segments.length - 1]!),
    dirSegments: segments.slice(0, -1),
    relativePath: segments.slice(0, -1).join('/'),
  }] as any;
}

describe('prepareDirectories 目录查询与分享竞态保护', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    folderStore.tree = [];
    folderStore.breadcrumb = [];
    folderStore.fetchTree.mockResolvedValue(undefined);
    folderStore.findInTree.mockReturnValue(undefined);
  });

  it('同一目标路径的并发准备共享一次创建请求', async () => {
    let resolvePost: (response: unknown) => void = () => {};
    api.post.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve; }));

    const first = prepareDirectories(null, parsed('photos/a.jpg'));
    const second = prepareDirectories(null, parsed('photos/b.jpg'));
    await Promise.resolve();
    expect(api.post).toHaveBeenCalledTimes(1);

    resolvePost({ data: { data: { folder: { id: 'folder-1', name: 'photos', parentId: null } } } });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.dirIdMap.get('photos')).toBe('folder-1');
    expect(secondResult.dirIdMap.get('photos')).toBe('folder-1');
  });

  it('创建遇到同层重名 400 时查询 contents 并复用已有目录', async () => {
    api.post.mockRejectedValueOnce({ response: { status: 400 }, message: 'duplicate' });
    api.get.mockResolvedValueOnce({
      data: { data: { subfolders: [{ id: 'existing-1', name: 'photos' }] } },
    });

    const result = await prepareDirectories(null, parsed('photos/a.jpg'));

    expect(api.post).toHaveBeenCalledWith('/folders', { name: 'photos', parentId: null });
    expect(api.get).toHaveBeenCalledWith('/folders/contents', { params: {} });
    expect(result.dirIdMap.get('photos')).toBe('existing-1');
    expect(result.reusedCount).toBe(1);
    expect(result.createdCount).toBe(0);
  });
});

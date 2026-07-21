import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from './auth';
import type { FileItem } from '../types/file';

/** 文件夹类型 */
export interface Folder {
  id: string;
  name: string;
  ownerId: string;
  parentId: string | null;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  children?: Folder[];
}

/** 文件夹内容（子文件夹 + 文件） */
export interface FolderContents {
  subfolders: Folder[];
  files: FileItem[];
}

/**
 * 文件夹 Pinia store：管理网盘文件夹层级状态。
 *
 * - tree: 当前用户的完整文件夹树（左侧导航用）
 * - currentFolderId: 当前打开的文件夹，null 表示根目录
 * - breadcrumb: 从根到当前文件夹的路径
 *
 * 文件列表本身仍在 useFileStore 里管理；本 store 只负责文件夹。
 * 父组件通过 currentFolderId 触发 fileStore.fetchFiles({ folderId })。
 */
export const useFolderStore = defineStore('folders', () => {
  const tree = ref<Folder[]>([]);
  const currentFolderId = ref<string | null>(null);
  const breadcrumb = ref<Folder[]>([]);
  const loading = ref(false);

  /** 当前所在文件夹的名称（用于页面标题/面包屑最后一段） */
  const currentFolderName = computed(() => {
    if (!currentFolderId.value) return '我的文件';
    return breadcrumb.value[breadcrumb.value.length - 1]?.name || '文件夹';
  });

  /** 拉取当前用户的完整文件夹树 */
  async function fetchTree() {
    loading.value = true;
    try {
      const res = await api.get('/folders/tree');
      tree.value = res.data.data.tree;
    } finally {
      loading.value = false;
    }
  }

  /** 切换当前文件夹，并同步拉取面包屑 */
  async function openFolder(folderId: string | null) {
    currentFolderId.value = folderId;
    if (folderId) {
      const res = await api.get('/folders/breadcrumb', { params: { parentId: folderId } });
      breadcrumb.value = res.data.data.breadcrumb;
    } else {
      breadcrumb.value = [];
    }
  }

  /** 创建文件夹 */
  async function createFolder(name: string, parentId: string | null = currentFolderId.value) {
    const res = await api.post('/folders', { name, parentId });
    await fetchTree();
    return res.data.data.folder as Folder;
  }

  /** 重命名文件夹 */
  async function renameFolder(id: string, name: string) {
    const res = await api.patch(`/folders/${id}`, { name });
    await fetchTree();
    // 同步更新面包屑里的同名条目
    const idx = breadcrumb.value.findIndex((f) => f.id === id);
    if (idx >= 0) breadcrumb.value[idx].name = name;
    return res.data.data.folder as Folder;
  }

  /** 移动文件夹 */
  async function moveFolder(id: string, parentId: string | null) {
    await api.patch(`/folders/${id}/move`, { parentId });
    await fetchTree();
  }

  /** 软删除文件夹（7 天延迟机制） */
  async function deleteFolder(id: string) {
    await api.delete(`/folders/${id}`);
    await fetchTree();
  }

  /** 恢复已删除的文件夹 */
  async function restoreFolder(id: string) {
    await api.post(`/folders/${id}/restore`);
    await fetchTree();
  }

  /** 列出指定文件夹的内容（子文件夹 + 文件） */
  async function listContents(folderId: string | null = currentFolderId.value): Promise<FolderContents> {
    const params = folderId ? { parentId: folderId } : {};
    const res = await api.get('/folders/contents', { params });
    return res.data.data as FolderContents;
  }

  /** 移动文件到指定文件夹 */
  async function moveFile(fileId: string, folderId: string | null) {
    await api.patch(`/files/${fileId}/move`, { folderId });
  }

  /**
   * 在 tree 中递归查找某个 folder 的引用（用于 UI 高亮/展开等）。
   * 返回该节点 + 其在父级 children 数组中的位置，方便就地更新。
   */
  function findInTree(nodes: Folder[], id: string): Folder | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children?.length) {
        const found = findInTree(n.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  return {
    tree,
    currentFolderId,
    breadcrumb,
    loading,
    currentFolderName,
    fetchTree,
    openFolder,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    restoreFolder,
    listContents,
    moveFile,
    findInTree,
  };
});

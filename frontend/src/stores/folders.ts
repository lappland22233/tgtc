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

  // 竞态保护：快速切换文件夹时取消上一次未完成的树/面包屑请求，避免旧响应覆盖新状态
  let treeAbortController: AbortController | null = null;
  let breadcrumbAbortController: AbortController | null = null;

  /** 拉取当前用户的完整文件夹树 */
  async function fetchTree() {
    if (treeAbortController) treeAbortController.abort();
    const controller = new AbortController();
    treeAbortController = controller;
    loading.value = true;
    try {
      const res = await api.get('/folders/tree', { signal: controller.signal });
      if (controller.signal.aborted) return;
      tree.value = res.data.data.tree;
    } catch (err) {
      const e = err as { name?: string; code?: string };
      // 被新请求取消的旧请求：静默忽略
      if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') return;
      throw err;
    } finally {
      // 仅当仍是当前控制器时才复位，避免旧请求提前清除新请求的加载态
      if (treeAbortController === controller) {
        treeAbortController = null;
        loading.value = false;
      }
    }
  }

  /** 切换当前文件夹，并同步拉取面包屑 */
  async function openFolder(folderId: string | null) {
    if (breadcrumbAbortController) breadcrumbAbortController.abort();
    const controller = new AbortController();
    breadcrumbAbortController = controller;

    currentFolderId.value = folderId;
    if (folderId) {
      try {
        const res = await api.get('/folders/breadcrumb', {
          params: { parentId: folderId },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        breadcrumb.value = res.data.data.breadcrumb;
      } catch (err) {
        const e = err as { name?: string; code?: string };
        if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') return;
        // 失败时清空面包屑，避免 currentFolderId 已切换但面包屑仍是旧路径的不一致状态
        breadcrumb.value = [];
        throw err;
      } finally {
        if (breadcrumbAbortController === controller) {
          breadcrumbAbortController = null;
        }
      }
    } else {
      breadcrumb.value = [];
    }
  }

  /** 创建文件夹 */
  async function createFolder(name: string, parentId: string | null = currentFolderId.value) {
    const res = await api.post('/folders', { name, parentId });
    const folder = res.data.data.folder as Folder;
    // 创建已成功，树刷新若因竞态/网络失败则降级处理，不向调用方抛出异常（避免误报“创建失败”）
    try {
      await fetchTree();
    } catch (err) {
      console.warn('[folders] 文件夹已创建成功，但刷新文件夹树失败，稍后重试可恢复：', err);
    }
    return folder;
  }

  /**
   * 将新建文件夹乐观插入 tree 中对应父节点的 children（按同 id 去重）。
   * 用于树刷新失败/竞态时的兜底展示；父节点为 null 时插入根级。
   */
  function insertIntoTree(folder: Folder, parentId: string | null) {
    const insert = (list: Folder[]) => {
      if (list.some((f) => f.id === folder.id)) return; // 同 id 去重
      list.push({ ...folder, children: folder.children ?? [] });
    };
    if (!parentId) {
      insert(tree.value);
      return;
    }
    const parent = findInTree(tree.value, parentId);
    if (!parent) return; // 树中找不到父节点则不插入，避免错误挂到根级
    if (!parent.children) parent.children = [];
    insert(parent.children);
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
    // 迭代遍历（显式栈）替代递归，避免极端深层文件夹树导致调用栈溢出
    const stack: Folder[] = [...nodes];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.id === id) return node;
      if (node.children?.length) {
        stack.push(...node.children);
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
    insertIntoTree,
  };
});

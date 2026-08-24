import type { Folder } from '../stores/folders';

/**
 * 返回当前目录的父目录。
 *
 * tree 可能尚未加载完整；此时优先使用路由/store 已确认的当前目录节点，
 * 避免把普通用户从深层目录错误地导航回根目录。
 */
export function getParentFolderId(
  tree: Folder[],
  currentFolderId: string | null,
  currentFolder?: Pick<Folder, 'id' | 'parentId'> | null,
): string | null {
  if (!currentFolderId) return null;
  const stack = [...tree];
  while (stack.length > 0) {
    const folder = stack.pop()!;
    if (folder.id === currentFolderId) return folder.parentId ?? null;
    if (folder.children?.length) stack.push(...folder.children);
  }
  if (currentFolder?.id === currentFolderId) return currentFolder.parentId ?? null;
  return null;
}

/**
 * 文件行（列表行/卡片）的纯判定函数。
 *
 * M6 拆分专项：这些判定原先分散在 `views/user/FileList.vue` 内联使用，
 * 桌面列表与移动列表拆为独立组件后，需要由宿主与子组件共用同一实现，
 * 因此集中到此模块（纯函数、无状态、可单测），避免两处逻辑漂移。
 *
 * 它们只依赖文件对象的只读字段，不访问 store、不发起请求。
 */
import { isPreviewable } from './preview';
import type { FileItem } from '../types/file';

/** 用户自助永久删除冷静期（与后端 FILE_FORCE_DELETE_WAIT_MS 一致） */
export const FORCE_DELETE_WAIT_MS = 60_000;

/** 行是否可操作：非处理中且未删除（决定可选、可拖、可下载） */
export function isFileActionable(row: Pick<FileItem, 'status' | 'isDeleted'>): boolean {
  return row.status !== 'processing' && !row.isDeleted;
}

/** 是否可点击预览：类型可预览且文件处于可用状态（非删除/处理中） */
export function canPreviewFile(file: Pick<FileItem, 'mimeType' | 'originalName' | 'isDeleted' | 'status'>): boolean {
  return isPreviewable(file.mimeType, file.originalName)
    && !file.isDeleted
    && file.status !== 'processing';
}

/** 行附加类名：处理中优先于已删除（两者互斥，保持与拆分前一致的判定顺序） */
export function getFileRowClassName(row: Pick<FileItem, 'status' | 'isDeleted'>): string {
  if (row.status === 'processing') return 'row-processing';
  return row.isDeleted ? 'row-deleted' : '';
}

/**
 * 非管理员：文件软删满冷静期后可自助永久删除。
 * `now` 可注入以便测试，默认取当前时间。
 */
export function selfForceDeleteReady(
  file: Pick<FileItem, 'deleteRequestedAt'>,
  now: number = Date.now(),
): boolean {
  if (!file.deleteRequestedAt) return false;
  return now - new Date(file.deleteRequestedAt).getTime() >= FORCE_DELETE_WAIT_MS;
}

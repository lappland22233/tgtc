export function formatSize(bytes: number | string): string {
  // 防御：字符串 → 数字（后端 bigint 序列化可能返回字符串）
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(k)), sizes.length - 1);
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 紧凑文件大小格式化（B 取整、KB 及以上保留 1 位小数）。
 *
 * 与上方 `formatSize` 的差异仅在精度与去尾策略（如 1.25 MB：本函数输出 "1.3 MB"，
 * 上方输出 "1.25 MB"）。预览弹窗（播放列表 / 底部元信息）的历史输出即为此格式，
 * 改动会造成用户可见的文案变化，因此保留两个变体，勿合并。
 *
 * 允许 null/undefined：后端 bigint 序列化可能返回字符串或空值。
 */
export function formatSizeCompact(bytes: number | string | null | undefined): string {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = num;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(date: string): string {
  if (!date) return '-';
  const d = new Date(date);
  // 非法日期不展示 "Invalid Date"，统一降级为占位符
  return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('zh-CN');
}

/**
 * 格式化为相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前），
 * 超出一年降级为 formatDate；非法日期返回 '-'。
 * 供 FileCard / FolderCard 复用，避免重复实现。
 */
export function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '-';

  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  if (days < 365) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return formatDate(dateStr);
}

/**
 * @deprecated Use FileTypeIcon component or getFileIconType() instead.
 * Kept for backward compatibility — returns empty string so callers
 * that still pass the result to ThumbnailImg's emoji prop won't render emoji.
 */
export function getFileEmoji(_mimeType?: string): string {
  return '';
}

// Re-export for convenience: import { getFileIconType } from '@/utils/format'
export { getFileIconType } from './file-icon-type';

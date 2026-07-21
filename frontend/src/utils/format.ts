export function formatSize(bytes: number): string {
  // 防御 NaN/Infinity/负数，避免输出 "NaN undefined"
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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

export function getFileEmoji(mimeType?: string): string {
  if (!mimeType) return '📎';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
  if (mimeType.includes('text')) return '📝';
  return '📎';
}

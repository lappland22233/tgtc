/**
 * File type detection utility — determines icon category from MIME type / file name.
 * Replaces the old getFileEmoji() function.
 */

export type FileIconType =
  | 'image' | 'video' | 'audio' | 'pdf' | 'word'
  | 'excel' | 'ppt' | 'archive' | 'code' | 'text'
  | 'folder' | 'generic';

export function getFileIconType(mimeType?: string, fileName?: string): FileIconType {
  const m = (mimeType || '').toLowerCase();
  const name = (fileName || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() || '' : '';

  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.includes('word') || m.includes('document') || ['doc', 'docx'].includes(ext)) return 'word';
  if (m.includes('excel') || m.includes('sheet') || m.includes('csv') || ['xls', 'xlsx', 'csv'].includes(ext)) return 'excel';
  if (m.includes('powerpoint') || m.includes('presentation') || ['ppt', 'pptx'].includes(ext)) return 'ppt';
  if (m.includes('zip') || m.includes('rar') || m.includes('7z') || m.includes('tar') || m.includes('gzip') || ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'archive';
  if (['js', 'ts', 'vue', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'rb', 'php', 'sh', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'sql'].includes(ext)) return 'code';
  if (m.startsWith('text/') || ['txt', 'md', 'log', 'ini', 'conf'].includes(ext)) return 'text';

  return 'generic';
}

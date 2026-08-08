/**
 * 预览响应防 XSS 加固：将可能执行脚本的标记类型
 * （text/html、image/svg+xml、各类 xml）强制降级为 text/plain，
 * 配合 X-Content-Type-Options: nosniff 阻止浏览器把上传内容渲染为活动文档。
 * 供文件预览端点与分享预览端点共用。
 */
export function sanitizePreviewContentType(contentType: string): string {
  // 先剥离 MIME 参数（如 charset/version）再比较，防止 "text/html; charset=utf-8" 等带参声明绕过降级
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'image/svg+xml' || type.includes('xml')) {
    return 'text/plain';
  }
  return contentType;
}

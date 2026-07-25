/**
 * 浏览器原生下载工具。
 *
 * 统一所有下载入口：通过创建 <a> 并触发 click，交由浏览器原生下载器处理
 * （自带下载进度、暂停/恢复、保存到下载目录），不使用 fetch + blob 方案
 * （后者会把整个文件读进内存，大文件会"挂起"且占用大量内存）。
 *
 * 后端下载接口已返回 `Content-Disposition: attachment`，浏览器会直接下载；
 * `download` 属性作为同源场景下的文件名兜底。
 */

/**
 * 触发浏览器原生下载。
 * @param url 下载地址（同源 /api/... 或带鉴权参数的分享地址）
 * @param filename 期望的下载文件名（可选；同源时作为 download 属性兜底）
 */
export function triggerBrowserDownload(url: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.style.display = 'none';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // 延迟移除，确保各浏览器（尤其移动端）已启动下载，避免同步移除导致下载被取消
  window.setTimeout(() => a.remove(), 1000);
}

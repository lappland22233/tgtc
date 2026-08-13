/**
 * 文件预览工具 —— 判断可预览类型并构造登录态 / 分享预览 URL。
 *
 * 预览接口（返回 inline 内容）：
 * - 登录态: GET /api/files/:fileId/preview（同源 Cookie 自动携带，支持 Range）
 * - 分享:   GET /api/s/:token/preview/:fileId（密码分享凭据通过 HttpOnly Cookie 携带，
 *           前端不再持有或拼接 access JWT，防止凭据落入 URL、Referer、日志与导出）
 */

import { getFileIconType } from './file-icon-type';
import api from '../api/client';

/** 支持在线预览的内容类别 */
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

/**
 * XSS 载体 MIME 硬排除清单（忽略大小写）：
 * 即使图标分类命中可预览类别，这类内容也绝不在预览中内联渲染。
 */
const BLOCKED_PREVIEW_MIME = new Set(['text/html', 'image/svg+xml']);

/**
 * 根据 MIME 类型 / 文件名推断预览类别。
 * 基于 getFileIconType() 的分类映射：
 * image/video/audio/pdf 直接对应；'text' 与 'code' 归为 'text'；其余返回 null。
 * @returns 预览类别；不可预览（含 XSS 载体）时返回 null
 */
export function getPreviewKind(mimeType?: string, fileName?: string): PreviewKind | null {
  // 先剥离 MIME 参数（如 charset）再比对，与后端 sanitizePreviewContentType 保持一致，
  // 防止 "text/html; charset=utf-8" 等带参声明绕过黑名单
  const m = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (BLOCKED_PREVIEW_MIME.has(m)) return null;

  const icon = getFileIconType(mimeType, fileName);
  switch (icon) {
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
      return icon;
    case 'text':
    case 'code':
      return 'text';
    default:
      return null;
  }
}

/** 是否支持在线预览 */
export function isPreviewable(mimeType?: string, fileName?: string): boolean {
  return getPreviewKind(mimeType, fileName) !== null;
}

/**
 * 构造登录态预览 URL（同源，Cookie 自动携带）。
 */
export function buildFilePreviewUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}/preview`;
}

/**
 * 构造分享缩略图 URL。
 * 凭据由 HttpOnly Cookie 携带，URL 中不包含任何访问 JWT（C-02 修复）。
 */
export function buildShareThumbnailUrl(token: string, fileId: string): string {
  return `/api/s/${encodeURIComponent(token)}/thumbnail/${encodeURIComponent(fileId)}`;
}

/** 构造分享高清封面 URL（凭据同样由 Cookie 携带）。 */
export function buildShareHdThumbnailUrl(token: string, fileId: string): string {
  return `/api/s/${encodeURIComponent(token)}/thumbnail-hd/${encodeURIComponent(fileId)}`;
}

/** 构造分享预览 URL（凭据由 Cookie 携带）。 */
export function buildSharePreviewUrl(token: string, fileId: string): string {
  return `/api/s/${encodeURIComponent(token)}/preview/${encodeURIComponent(fileId)}`;
}

/**
 * 媒体直链仅适用于图片 / 视频 / 音频（供「复制媒体直链」判断使用）。
 */
export function isMediaDirectLinkKind(kind: PreviewKind | null): kind is 'image' | 'video' | 'audio' {
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

/** 缓存状态三态：cached=已有正式缓存；cold=需冷回源；unknown=无法确定 */
export type CacheStatus = 'cached' | 'cold' | 'unknown';

/**
 * 登录态查询文件缓存状态。
 * 供视频预览判断冷资源单连接策略：cold/unknown 时保守钳制 seek，cached 时恢复 Range 跳转。
 * 查询失败返回 unknown（保守限制 seek，避免对未缓存文件发起动态分段回源）。
 */
export async function fetchFileCacheStatus(fileId: string): Promise<CacheStatus> {
  try {
    const res = await api.get(`/files/${encodeURIComponent(fileId)}/cache-status`);
    return res.data?.data?.status === 'cached' ? 'cached' : 'cold';
  } catch {
    return 'unknown';
  }
}

/** 分享态查询文件缓存状态（与登录态同语义，凭据由 Cookie 携带）。 */
export async function fetchShareCacheStatus(token: string, fileId: string): Promise<CacheStatus> {
  try {
    const res = await api.get(`/s/${encodeURIComponent(token)}/cache-status/${encodeURIComponent(fileId)}`);
    return res.data?.data?.status === 'cached' ? 'cached' : 'cold';
  } catch {
    return 'unknown';
  }
}

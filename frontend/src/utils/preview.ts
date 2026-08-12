/**
 * 文件预览工具 —— 判断可预览类型并构造登录态 / 分享预览 URL。
 *
 * 预览接口（返回 inline 内容）：
 * - 登录态: GET /api/files/:fileId/preview（同源 Cookie 自动携带，支持 Range）
 * - 分享:   GET /api/s/:token/preview/:fileId（密码分享附 ?access=<JWT>）
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
 * 构造分享预览 URL。
 * 固定同源拼接，密码分享时把后端签发的访问 JWT 附在 access 查询参数中，
 * 禁止把 JWT 附加到外部传入的任意 URL。
 */
export function buildShareThumbnailUrl(token: string, fileId: string, accessJwt?: string): string {
  const base = `/api/s/${encodeURIComponent(token)}/thumbnail/${encodeURIComponent(fileId)}`;
  return accessJwt ? `${base}?access=${encodeURIComponent(accessJwt)}` : base;
}

/** 构造分享高清封面 URL（密码分享时附 access JWT）。 */
export function buildShareHdThumbnailUrl(token: string, fileId: string, accessJwt?: string): string {
  const base = `/api/s/${encodeURIComponent(token)}/thumbnail-hd/${encodeURIComponent(fileId)}`;
  return accessJwt ? `${base}?access=${encodeURIComponent(accessJwt)}` : base;
}

export function buildSharePreviewUrl(token: string, fileId: string, accessJwt?: string): string {
  const base = `/api/s/${encodeURIComponent(token)}/preview/${encodeURIComponent(fileId)}`;
  return accessJwt ? `${base}?access=${encodeURIComponent(accessJwt)}` : base;
}

/**
 * 媒体直链仅适用于图片 / 视频 / 音频（供「复制媒体直链」判断使用）。
 */
export function isMediaDirectLinkKind(kind: PreviewKind | null): kind is 'image' | 'video' | 'audio' {
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

/**
 * 登录态查询文件是否已有正式本地缓存。
 * 供视频预览判断冷资源单连接策略：未缓存时钳制 seek，缓存完成后恢复 Range 跳转。
 * 查询失败时按「已缓存」处理，避免误锁进度条。
 */
export async function fetchFileCacheStatus(fileId: string): Promise<boolean> {
  try {
    const res = await api.get(`/files/${encodeURIComponent(fileId)}/cache-status`);
    return res.data?.data?.cached === true;
  } catch {
    return true;
  }
}

/** 分享态查询文件是否已有正式本地缓存（与登录态同语义）。 */
export async function fetchShareCacheStatus(
  token: string,
  fileId: string,
  accessJwt?: string,
): Promise<boolean> {
  try {
    const suffix = accessJwt ? `?access=${encodeURIComponent(accessJwt)}` : '';
    const res = await api.get(
      `/s/${encodeURIComponent(token)}/cache-status/${encodeURIComponent(fileId)}${suffix}`,
    );
    return res.data?.data?.cached === true;
  } catch {
    return true;
  }
}

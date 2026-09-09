import api from './client';

/** 下载链接模式 */
export type DownloadLinkMode = 'permanent' | 'timed' | 'count_limited';

export interface DownloadLinkResult {
  mode: DownloadLinkMode;
  /** 后端基于 APP_URL 生成的链接（前端展示时统一以当前 origin 重建） */
  url: string;
  /** permanent 模式下为文件 id（旧公开链接），timed / count_limited 为分享 token */
  token: string;
  expiresIn: number | null;
  maxAccessCount: number;
}

/**
 * 获取下载链接（三种模式）：
 * - permanent：将文件转换为公开文件并返回公开下载链接
 * - timed：限时公开下载链接（durationHours：1-720 小时）
 * - count_limited：限次数下载链接（maxAccessCount：1-1000000）
 */
export async function fetchDownloadLink(
  fileId: string,
  mode: DownloadLinkMode,
  params?: { durationHours?: number; maxAccessCount?: number },
): Promise<DownloadLinkResult> {
  // 写语义端点（permanent 会将文件转公开）：必须 POST，防跨站顶层导航 CSRF（P1-10）
  const res = await api.post(`/files/${fileId}/download-link`, null, {
    params: {
      mode,
      ...(mode === 'timed' ? { durationHours: params?.durationHours } : {}),
      ...(mode === 'count_limited' ? { maxAccessCount: params?.maxAccessCount } : {}),
    },
  });
  return res.data?.data;
}

/** 以当前站点 origin 构建可直接访问的链接（与「我的分享」列表口径一致） */
export function buildBrowsableLink(result: DownloadLinkResult): string {
  const origin = window.location.origin;
  return result.mode === 'permanent'
    ? `${origin}/files/public/${result.token}`
    : `${origin}/s/${result.token}`;
}

import api from './client';

/** 下载任务状态：queued = 排队中（磁盘/上游/服务器负载），streamable = 可开始下载 */
export type DownloadTaskStatus = 'queued' | 'streamable' | 'cancelled' | 'expired';

/** 排队原因：磁盘空间 / 上游回源连接 / 服务器综合负载 */
export type DownloadQueueReason = 'disk' | 'upstream' | 'server_load';

/**
 * 传输模式：
 * - cache：走正式缓存 / 临时暂存（会占用本地缓存/磁盘预约）；
 * - direct：结构性不可行（完整暂存放不下）时的有界直通，不占本地缓存。
 *
 * 注意：`direct` 任务在资源就绪判定后**立即返回 `streamable`**，因此前端
 * 不得再把 `mode === 'direct'` 当作「永远在排队」——它就是「可立即下载」。
 */
export type DownloadTaskMode = 'cache' | 'direct';

export interface DownloadTaskView {
  taskId: string;
  status: DownloadTaskStatus;
  queueReason?: DownloadQueueReason;
  /** 近似队列位置（1 = 队首） */
  queuePosition?: number;
  /** 建议的重试间隔（毫秒） */
  retryAfterMs?: number;
  expectedSize: number;
  /**
   * 资源就绪时给出的下载地址（同源 cookie 鉴权）。
   * 就绪时后端已自带一次性 `?taskTicket=<ticket>`，前端**无需**自行拼接，直接用返回值即可。
   */
  downloadUrl?: string;
  /** 一次性票据（仅资源就绪时给出；正文请求消费后失效） */
  ticket?: string;
  /** 票据过期时间（ISO 字符串） */
  ticketExpiresAt?: string;
  /** 传输模式：cache（缓存/临时暂存）或 direct（有界直通，不占本地缓存） */
  mode?: DownloadTaskMode;
  expiresAt: string;
  errorCode?: string;
  message?: string;
}

/**
 * 创建下载任务（两阶段下载的第一阶段）。
 * 返回能否立即下载，或排队原因/位置/建议重试间隔；任务本身不传输文件。
 */
export async function createDownloadTask(
  fileId: string,
  params?: { nocache?: boolean },
): Promise<DownloadTaskView> {
  const res = await api.post(`/files/${fileId}/download-tasks`, params ?? {});
  return res.data?.data;
}

/** 查询任务状态（服务端每次都会重新评估队列情况） */
export async function fetchDownloadTask(taskId: string): Promise<DownloadTaskView> {
  const res = await api.get(`/download-tasks/${taskId}`);
  return res.data?.data;
}

/** 取消排队中的任务（幂等） */
export async function cancelDownloadTask(taskId: string): Promise<DownloadTaskView> {
  const res = await api.delete(`/download-tasks/${taskId}`);
  return res.data?.data;
}

import api from './client';

/** 下载任务状态：queued = 排队中（磁盘/上游/服务器负载），streamable = 可开始下载 */
export type DownloadTaskStatus = 'queued' | 'streamable' | 'cancelled' | 'expired';

/** 排队原因：磁盘空间 / 上游回源连接 / 服务器综合负载 */
export type DownloadQueueReason = 'disk' | 'upstream' | 'server_load';

export interface DownloadTaskView {
  taskId: string;
  status: DownloadTaskStatus;
  queueReason?: DownloadQueueReason;
  /** 近似队列位置（1 = 队首） */
  queuePosition?: number;
  /** 建议的重试间隔（毫秒） */
  retryAfterMs?: number;
  expectedSize: number;
  downloadUrl?: string;
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

import api from './client';

export interface AdminFileItem {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  accessType: string;
  createdAt: string;
  isDeleted?: boolean;
  deletedByAdmin?: boolean;
  deleteRequestedAt?: string | null;
  uploader: { id: string; email: string } | null;
}

export interface AdminFileQuery {
  page: number;
  limit: number;
  keyword?: string;
  userId?: string;
  sortBy?: string;
  sortOrder?: string;
  signal?: AbortSignal;
}

export async function fetchAllAdminFiles(query: AdminFileQuery): Promise<{ files: AdminFileItem[]; total: number }> {
  const { signal, ...params } = query;
  const response = await api.get('/admin/files', { params, signal });
  return {
    files: response.data.data.files as AdminFileItem[],
    total: response.data.data.total as number,
  };
}

/** 文件体检任务状态 */
export type FileVerifyTaskStatus = 'queued' | 'running' | 'completed' | 'failed';

/** 文件体检任务 */
export interface FileVerifyTask {
  taskId: string;
  status: FileVerifyTaskStatus;
  mode: 'dry-run' | 'apply';
  allReady: boolean;
  limit: number;
  concurrency: number;
  totalCandidates: number; // 候选总数（开始执行后才有值）
  processed: number; // 已处理数
  progress: number; // 0~100，后端已算好
  valid: number;
  invalid: number;
  emptyFileId: number;
  temporaryFailure: number;
  sizeMismatch: number;
  backfilled: number;
  markedError: number;
  errorSummary: string | null; // 仅 failed 时可能有值
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FileVerifyRequest {
  /** dry-run 仅统计（默认）；apply 会修改状态/回填路径 */
  mode?: 'dry-run' | 'apply';
  /** true 检查全部 ready 文件；默认仅检查 telegramFilePath 为空的候选 */
  allReady?: boolean;
  /** 单次最大检查数量 */
  limit?: number;
  /** 并发校验数 */
  concurrency?: number;
}

/** 创建文件体检任务（202）。isNewTask=false 表示已有活动任务，返回的是现有任务。 */
export async function createFileVerifyTask(
  req: FileVerifyRequest,
): Promise<{ task: FileVerifyTask; isNewTask: boolean }> {
  const response = await api.post('/admin/files/verify', req);
  return response.data.data as { task: FileVerifyTask; isNewTask: boolean };
}

/** 获取当前活动体检任务；无活动任务时返回 null */
export async function fetchActiveFileVerifyTask(signal?: AbortSignal): Promise<FileVerifyTask | null> {
  const response = await api.get('/admin/files/verify/active', { signal });
  return (response.data.data.task as FileVerifyTask | null) ?? null;
}

/** 按 taskId 获取体检任务 */
export async function fetchFileVerifyTask(taskId: string, signal?: AbortSignal): Promise<FileVerifyTask> {
  const response = await api.get(`/admin/files/verify/${taskId}`, { signal });
  return response.data.data.task as FileVerifyTask;
}

/** 存量旧路径清理结果 */
export interface StalePathCleanupResult {
  mode: 'dry-run' | 'apply';
  matched: number;
  updated: number;
}

/**
 * 存量旧路径清理（仅 SUPER_ADMIN）。
 * dry-run：仅统计命中 /data/cb/tgtc-beta/ 前缀的旧 telegramFilePath 数量，不修改；
 * apply：将这些记录的 telegramFilePath 清空为 NULL（幂等），不改变文件状态。
 */
export async function cleanupStalePaths(mode: 'dry-run' | 'apply'): Promise<StalePathCleanupResult> {
  const response = await api.post('/admin/files/stale-paths/cleanup', { mode });
  return response.data.data as StalePathCleanupResult;
}

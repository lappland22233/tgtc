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

/** 文件体检结果统计 */
export interface FileVerifyResult {
  mode: 'dry-run' | 'apply';
  totalCandidates: number;
  checked: number;
  valid: number;
  invalid: number;
  emptyFileId: number;
  temporaryFailure: number;
  sizeMismatch: number;
  backfilled: number;
  markedError: number;
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

export async function verifyAdminFiles(
  req: FileVerifyRequest = {},
): Promise<FileVerifyResult> {
  const response = await api.post('/admin/files/verify', req);
  return response.data.data as FileVerifyResult;
}

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

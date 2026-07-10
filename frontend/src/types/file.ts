export type FileAccessType = 'public' | 'private';

export interface Tag {
  id: string;
  name: string;
  color: string;
  userId: string;
  createdAt: string;
  fileCount?: number;
}

export interface Uploader {
  id: string;
  email: string;
}

export interface FileItem {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  accessType: FileAccessType;
  maxAccessCount: number;
  currentAccessCount: number;
  expiresIn: number | null;
  expiresStartAt: string | null;
  hasPassword: boolean;
  createdAt: string;
  uploader: Uploader | null;
  /** 是否已标记为删除（延迟删除状态） */
  isDeleted: boolean;
  /** 是否由管理员删除（普通用户不可恢复） */
  deletedByAdmin: boolean;
  /** 计划永久删除时间 */
  deleteScheduledAt: string | null;
  /** 请求删除时间 */
  deleteRequestedAt: string | null;
  /** 处理状态: processing=后台上传中, ready=就绪, error=失败 */
  status?: 'processing' | 'ready' | 'error';
  /** 关联标签 */
  tags?: Tag[];
}

export interface BatchUploadFailedItem {
  name: string;
  reason: string;
}

/** 批量上传成功项（仅需 id 和 originalName 用于前端展示） */
export type BatchUploadSuccessItem = Pick<FileItem, 'id' | 'originalName'>;

export interface BatchUploadResult {
  success: BatchUploadSuccessItem[];
  failed: BatchUploadFailedItem[];
}

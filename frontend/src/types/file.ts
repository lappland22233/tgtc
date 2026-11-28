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
  /**
   * 处理状态: processing=后台上传中, ready=就绪, error=失败。
   * 可选字段：部分列表接口可能不返回。消费方必须处理 undefined，
   * 应使用 `status === 'processing'` 等精确比较，不要假设默认值。
   */
  status?: 'processing' | 'ready' | 'error';
  /** 关联标签 */
  tags?: Tag[];
  /**
   * 文件内容版本（覆盖上传时递增）。
   * 媒体进度恢复据此判断记录是否仍适用于当前内容；
   * 可选字段：部分接口可能不返回，缺省时视为无版本信息。
   */
  uploadVersion?: number;
}

export interface BatchUploadFailedItem {
  name: string;
  reason: string;
  /**
   * 是否可安全重试（与后端 BatchUploadFailedItem 对齐）：
   * 类型/大小/同名冲突等确定性失败为 false，网络/数据库瞬时故障为 true。
   * A-20：此前前端手工镜像的类型缺该字段，后端「确定性失败不误导重试」的语义
   * 在 UI 侧完全不可用。可选字段，缺省时按可重试处理以保持既有行为。
   */
  retryable?: boolean;
}

/** 批量上传成功项（仅需 id 和 originalName 用于前端展示） */
export type BatchUploadSuccessItem = Pick<FileItem, 'id' | 'originalName'>;

export interface BatchUploadResult {
  success: BatchUploadSuccessItem[];
  failed: BatchUploadFailedItem[];
}

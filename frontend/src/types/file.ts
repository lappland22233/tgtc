export type FileAccessType = 'public' | 'private';

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
  hasPassword: boolean;
  createdAt: string;
  uploader: {
    id: string;
    email: string;
  } | null;
}

export interface BatchUploadFailedItem {
  name: string;
  reason: string;
}

export interface BatchUploadResult {
  success: FileItem[];
  failed: BatchUploadFailedItem[];
}

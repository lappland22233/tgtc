import { IsString, IsInt, Min, Max, IsUUID, IsOptional, IsArray, MaxLength } from 'class-validator';

/**
 * 分片上传单文件绝对上限（硬上限，仅用于拦截极端值防止磁盘分配 DoS）。
 * 精确的文件大小限制由服务端结合动态 MAX_FILE_SIZE 在 init 时校验。
 */
export const MAX_CHUNKED_FILE_SIZE = 50 * 1024 * 1024 * 1024; // 50GB
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024; // 16MB，确保单请求磁盘缓冲与在途预算有界

export class InitChunkUploadDto {
  @IsString()
  @MaxLength(255, { message: '文件名不能超过 255 个字符' })
  fileName: string;

  @IsInt()
  @Min(1)
  @Max(MAX_CHUNKED_FILE_SIZE, { message: '文件大小超过允许的上限' })
  fileSize: number;

  @IsString()
  @MaxLength(255, { message: 'mimeType 不能超过 255 个字符' })
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(20000)
  totalChunks: number;

  @IsInt()
  @Min(1)
  @Max(MAX_CHUNK_SIZE, { message: '单个分片不能超过 16MB' })
  chunkSize: number;

  @IsOptional()
  @IsUUID('4', { message: 'folderId 必须是合法的 UUID v4' })
  folderId?: string;

  /** 覆盖目标 File 记录 id（可选）：存在时 in-place 覆盖该文件，缺省为新建 */
  @IsOptional()
  @IsUUID('4', { message: 'overwriteFileId 必须是合法的 UUID v4' })
  overwriteFileId?: string;
}

export class CompleteChunkUploadDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  tagIds?: string[];
}

import { IsString, IsInt, Min, Max, IsUUID, IsOptional, IsArray } from 'class-validator';

export class InitChunkUploadDto {
  @IsString()
  fileName: string;

  @IsInt()
  @Min(1)
  fileSize: number;

  @IsString()
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(20000)
  totalChunks: number;

  @IsInt()
  @Min(1)
  @Max(104857600) // 100MB max chunk size
  chunkSize: number;
}

export class CompleteChunkUploadDto {
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  tagIds?: string[];
}

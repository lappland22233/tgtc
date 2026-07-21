import { IsString, MaxLength, IsOptional, IsUUID, IsBoolean } from 'class-validator';

export class CreateFolderDto {
  @IsString()
  @MaxLength(255)
  name: string;

  /** 父文件夹 ID；省略或 null 表示在网盘根目录创建 */
  @IsOptional()
  @IsUUID('4')
  parentId?: string | null;
}

export class RenameFolderDto {
  @IsString()
  @MaxLength(255)
  name: string;
}

export class MoveFolderDto {
  /** 新的父文件夹 ID；null 表示移动到网盘根目录 */
  @IsOptional()
  @IsUUID('4')
  parentId?: string | null;
}

export class MoveFileDto {
  /** 目标文件夹 ID；null 表示移动到网盘根目录 */
  @IsOptional()
  @IsUUID('4')
  folderId?: string | null;
}

export class ListContentsQueryDto {
  /** 父文件夹 ID；省略表示根目录 */
  @IsOptional()
  @IsUUID('4')
  parentId?: string | null;

  @IsOptional()
  @IsBoolean()
  includeDeleted?: boolean;
}

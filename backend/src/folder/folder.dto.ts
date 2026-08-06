import { IsString, MaxLength, IsOptional, IsUUID, IsBoolean, IsNotEmpty, Matches } from 'class-validator';
import { Transform as ClassTransform } from 'class-transformer';

/**
 * 文件夹名称合法字符集：字母（含中文）/数字/连接符标点（下划线等）/空格/半角点/半角连字符，
 * 以及全角空格\u3000、全角点\uFF0E。封堵 `/ \ : * ? " < > |` 等路径穿越与 Windows 非法字符。
 * 保留名称（'.'/'..'/CON 等设备名）能通过字符集校验，由服务层 assertFolderNameAllowed 拒绝。
 * 注意：@Matches 校验的是 class-transformer 处理后的值，下方 Transform 已先 trim，
 * 故首尾空格不会误伤也不会漏检。
 */
const FOLDER_NAME_PATTERN = /^[\p{L}\p{N}\p{Pc} .\-\u3000\uFF0E]+$/u;
const FOLDER_NAME_MESSAGE = '文件夹名称包含非法字符';

export class CreateFolderDto {
  @IsString()
  @IsNotEmpty({ message: '文件夹名称不能为空' })
  @ClassTransform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(FOLDER_NAME_PATTERN, { message: FOLDER_NAME_MESSAGE })
  @MaxLength(255)
  name: string;

  /** 父文件夹 ID；省略或 null 表示在网盘根目录创建 */
  @IsOptional()
  @IsUUID('4')
  parentId?: string | null;
}

export class RenameFolderDto {
  @IsString()
  @IsNotEmpty({ message: '文件夹名称不能为空' })
  @ClassTransform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(FOLDER_NAME_PATTERN, { message: FOLDER_NAME_MESSAGE })
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

export class RenameFileDto {
  /** 新的文件显示名（originalName） */
  @IsString()
  @IsNotEmpty({ message: '文件名不能为空' })
  @ClassTransform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(255)
  newOriginalName: string;
}

export class CopyFileDto {
  /** 目标文件夹 ID；null 表示复制到网盘根目录 */
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
  @ClassTransform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeDeleted?: boolean;
}

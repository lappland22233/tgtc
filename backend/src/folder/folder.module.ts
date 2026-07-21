import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Folder } from '../common/entities/folder.entity';
import { File } from '../common/entities/file.entity';
import { FolderController } from './folder.controller';
import { FolderService } from './folder.service';

/**
 * 文件夹模块：网盘层级管理。
 *
 * 注入 Folder 和 File 两个 entity：
 * - Folder 用 TreeRepository（closure-table）做层级查询
 * - File 用于 listContents 联合查询和 moveFile 更新
 *
 * AuditModule 是全局模块，无需显式 import；AuditService 通过全局 DI 注入。
 */
@Module({
  imports: [TypeOrmModule.forFeature([Folder, File])],
  controllers: [FolderController],
  providers: [FolderService],
  exports: [FolderService],
})
export class FolderModule {}

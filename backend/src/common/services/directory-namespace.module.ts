import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DirectoryName } from '../entities/directory-name.entity';
import { DirectoryNamespaceService } from './directory-namespace.service';

/**
 * 统一目录命名空间模块（全局）。
 * FileService 与 FolderService 都需要注入 DirectoryNamespaceService，
 * 与 AuditModule 同模式做成全局模块，避免交叉模块依赖。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([DirectoryName])],
  providers: [DirectoryNamespaceService],
  exports: [DirectoryNamespaceService],
})
export class DirectoryNamespaceModule {}

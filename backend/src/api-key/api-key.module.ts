import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../common/entities/api-key.entity';
import { User } from '../common/entities/user.entity';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { JwtOrApiKeyAuthGuard } from './jwt-or-api-key.guard';

/**
 * API 密钥模块。
 *
 * - ApiKeyService：创建 / 列表 / 撤销 / 轮换 / 认证（owner-only 上下文注入）
 * - JwtOrApiKeyAuthGuard：X-API-Key 显式优先（失败不回退）、否则走 JWT 的组合认证 Guard，
 *   由 File / Folder / Share 等模块导入后替换原有 JwtAuthGuard 使用。
 *
 * AuditModule 是全局模块，AuditService 通过全局 DI 注入。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, User])],
  controllers: [ApiKeyController],
  providers: [ApiKeyService, JwtOrApiKeyAuthGuard],
  exports: [ApiKeyService, JwtOrApiKeyAuthGuard],
})
export class ApiKeyModule {}

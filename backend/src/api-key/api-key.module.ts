import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../common/entities/api-key.entity';
import { ApiKeyIpAllowlist } from '../common/entities/api-key-ip-allowlist.entity';
import { ApiKeyUsageLog } from '../common/entities/api-key-usage-log.entity';
import { User } from '../common/entities/user.entity';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { ApiKeyCryptoService } from './api-key-crypto.service';
import { ApiKeyUsageService } from './api-key-usage.service';
import { API_KEY_USAGE_INTERCEPTOR } from './api-key-usage.interceptor';
import { JwtOrApiKeyAuthGuard } from './jwt-or-api-key.guard';

/**
 * API 密钥模块。
 *
 * - ApiKeyService：创建 / 列表 / 撤销 / 轮换 / 认证（owner-only 上下文注入）、
 *   所有者重显明文（AES-256-GCM 密文）、每把密钥 IP 白名单
 * - ApiKeyUsageService：使用审计写入、7 天留存清理、所有者（脱敏）/管理员（明文）查询
 * - ApiKeyUsageInterceptor：全局拦截器，Guard 后归因 API Key 请求
 * - JwtOrApiKeyAuthGuard：X-API-Key 显式优先（失败不回退）、否则走 JWT 的组合认证 Guard，
 *   由 File / Folder / Share 等模块导入后替换原有 JwtAuthGuard 使用。
 *
 * AuditModule 是全局模块，AuditService 通过全局 DI 注入。
 */
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, ApiKeyIpAllowlist, ApiKeyUsageLog, User])],
  controllers: [ApiKeyController],
  providers: [ApiKeyService, ApiKeyCryptoService, ApiKeyUsageService, JwtOrApiKeyAuthGuard, API_KEY_USAGE_INTERCEPTOR],
  exports: [ApiKeyService, ApiKeyUsageService, JwtOrApiKeyAuthGuard],
})
export class ApiKeyModule {}

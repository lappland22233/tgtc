import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramAccount } from '../common/entities/telegram-account.entity';
import { TelegramAccountPoolModule } from '../telegram-account-pool/telegram-account-pool.module';
import { TelegramUserModule } from '../telegram-user/telegram-user.module';
import { TelegramAccountsController } from './telegram-accounts.controller';
import { TelegramAccountsService } from './telegram-accounts.service';
import { TelegramAccountCredentialModule } from './telegram-account-credential.module';
import { TelegramAccountFeatureService } from './telegram-account-feature.service';
import { TelegramAccountPoolBridgeService } from './telegram-account-pool-bridge.service';
import { TelegramAccountProbeService } from './telegram-account-probe.service';
import { TelegramReplicationAuditService } from './telegram-replication-audit.service';
import { TelegramUserAuthService } from './telegram-user-auth.service';

/**
 * Telegram 账号管理模块（后台账号池运营面）。
 *
 * 依赖方向（刻意单向，避免循环）：
 * - → `TelegramAccountCredentialModule`（凭据加解密，叶子模块）
 * - → `TelegramUserModule`（MTProto 适配层，叶子模块）
 * - → `TelegramAccountPoolModule`（复用账号级 Telegram 客户端做连通性探测）
 *
 * 反向依赖（账号池读取数据库账号）由账号池模块**直接注入实体仓库**完成，
 * 因此本模块不会被账号池模块 import，二者不会形成环。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TelegramAccount]),
    TelegramAccountCredentialModule,
    TelegramUserModule,
    TelegramAccountPoolModule,
  ],
  controllers: [TelegramAccountsController],
  providers: [
    TelegramAccountsService,
    TelegramAccountFeatureService,
    TelegramAccountProbeService,
    TelegramUserAuthService,
    TelegramAccountPoolBridgeService,
    TelegramReplicationAuditService,
  ],
  exports: [TelegramAccountsService, TelegramAccountFeatureService, TelegramReplicationAuditService],
})
export class TelegramAccountsModule {}

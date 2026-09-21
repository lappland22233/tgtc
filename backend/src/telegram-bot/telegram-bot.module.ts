import { Module } from '@nestjs/common';
import { TelegramAccountPoolModule } from '../telegram-account-pool/telegram-account-pool.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramModule } from '../telegram/telegram.module';
import { FileModule } from '../file/file.module';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramBotDailyUsage } from '../common/entities/telegram-bot-daily-usage.entity';
import { TelegramBotWhitelist } from '../common/entities/telegram-bot-whitelist.entity';
import { TelegramBotTokenCryptoService } from './telegram-bot-token-crypto.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';
import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotAdminService } from './telegram-bot-admin.service';
import { TelegramBotDispatchService } from './telegram-bot-dispatch.service';
import { TelegramBotPollingService } from './telegram-bot-polling.service';
import { TelegramBotPublicController } from './telegram-bot-public.controller';
import { TelegramBotAdminController } from './telegram-bot-admin.controller';

/**
 * Telegram Bot 文件直链模块。
 *
 * 与既有 `TelegramModule`（出站文件存储）解耦：本模块负责入站长轮询、
 * document 提取、配额判定、直链签发与匿名下载端点。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TelegramBotFileGrant, TelegramBotDailyUsage, TelegramBotWhitelist]),
    TelegramModule,
    // 复用 FileModule 导出的 FileCacheService（Range/断点续传与本地缓存）
    FileModule,
    // 多账号（Bot 账号池）：入站归属登记、副本扩散与按负载回源；未启用时不影响原链路
    TelegramAccountPoolModule,
  ],
  controllers: [TelegramBotPublicController, TelegramBotAdminController],
  providers: [
    TelegramBotTokenCryptoService,
    TelegramBotConfigService,
    TelegramBotQuotaService,
    TelegramBotGrantService,
    TelegramBotAdminService,
    TelegramBotDispatchService,
    TelegramBotPollingService,
  ],
  exports: [TelegramBotConfigService, TelegramBotGrantService],
})
export class TelegramBotModule {}

import { Module } from '@nestjs/common';
import { TelegramUserClientService } from './telegram-user-client.service';

/**
 * Telegram 用户账号（MTProto）客户端模块（叶子模块）。
 *
 * 账号管理模块用它完成交互式授权，镜像模块用它执行无源复制；两者都只依赖
 * 这一个无状态适配器，因此不会形成模块间循环依赖。
 */
@Module({
  providers: [TelegramUserClientService],
  exports: [TelegramUserClientService],
})
export class TelegramUserModule {}

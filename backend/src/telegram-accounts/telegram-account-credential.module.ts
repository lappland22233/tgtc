import { Module } from '@nestjs/common';
import { TelegramAccountCredentialService } from './telegram-account-credential.service';

/**
 * 账号凭据加密模块（叶子模块）。
 *
 * 为什么单独成模块：账号管理模块、账号池模块与镜像模块都需要解密凭据来调用
 * Telegram，如果把它放进其中任一业务模块，就会形成「账号管理 ↔ 账号池」的循环依赖。
 * 这里只暴露一个无状态加密服务，任何模块都可安全导入。
 */
@Module({
  providers: [TelegramAccountCredentialService],
  exports: [TelegramAccountCredentialService],
})
export class TelegramAccountCredentialModule {}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { OnEvent } from '@nestjs/event-emitter';
import { decryptPassword } from '../common/utils/crypto.util';

/** HTML 转义，防止注入攻击（即使 code 是数字也养成习惯，避免未来变量被替换为用户可控值） */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

@Injectable()
export class MailerService {
  private transporter: nodemailer.Transporter | null = null;
  private readonly logger = new Logger(MailerService.name);

  constructor(private configService: ConfigService) {}

  /** 严格解析字符串布尔值：仅 'true'（忽略大小写）为 true，'false'/空/其他均为 false */
  private parseBool(value: unknown): boolean {
    return String(value).toLowerCase() === 'true';
  }

  /** 统一处理 SMTP 密码解密，空密码返回空字符串 */
  private resolveSmtpPassword(encryptedPass: string | undefined): string {
    if (!encryptedPass) return '';
    return decryptPassword(encryptedPass);
  }

  private getOrCreateTransporter(): nodemailer.Transporter {
    if (this.transporter) {
      return this.transporter;
    }
    return this.createTransporter({
      host: this.configService.get<string>('SMTP_HOST') || '',
      port: this.configService.get<number>('SMTP_PORT') || 587,
      // 修复：env 字符串 'false' 为 truthy，必须严格解析，否则 587 STARTTLS 会误用 secure=true 连接失败
      secure: this.parseBool(this.configService.get<string>('SMTP_SECURE')),
      user: this.configService.get<string>('SMTP_USER') || '',
      pass: this.resolveSmtpPassword(this.configService.get<string>('SMTP_PASSWORD')),
    });
  }

  private createTransporter(config: SmtpConfig): nodemailer.Transporter {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      // 连接池复用 SMTP 连接，减少频繁握手开销
      pool: true,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
    return this.transporter;
  }

  @OnEvent('config.changed')
  rebuildTransporter(payload: { key: string; value: unknown }) {
    if (payload.key !== 'smtp_config') return;
    // 事件处理器内抛错会传播回 ConfigCacheService.set，
    // 导致配置已入库却返回 500。此处捕获并记录，保证 set 成功语义。
    try {
      const config = payload.value as SmtpConfig;
      config.pass = this.resolveSmtpPassword(config.pass);
      this.transporter = null;
      this.createTransporter(config);
      this.logger.log('SMTP transporter 已根据配置更新重建');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`SMTP transporter 重建失败: ${message}`);
    }
  }

  /** 发件人地址：优先 SMTP_FROM，回退 SMTP_USER，最后使用默认值，避免 from 为 undefined */
  private resolveFrom(): string {
    return (
      this.configService.get<string>('SMTP_FROM') ||
      this.configService.get<string>('SMTP_USER') ||
      'noreply@localhost'
    );
  }

  async sendVerificationCode(email: string, code: string): Promise<void> {
    const mailOptions = {
      from: this.resolveFrom(),
      to: email,
      subject: '邮箱验证码 - 文件分发系统',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">邮箱验证</h2>
          <p>您好，</p>
          <p>您的验证码是：<strong style="font-size: 24px; color: #0066FF;">${escapeHtml(code)}</strong></p>
          <p>验证码有效期为5分钟，请勿泄露给他人。</p>
          <p style="color: #666; font-size: 12px;">如果不是您本人操作，请忽略此邮件。</p>
        </div>
      `,
    };

    await this.getOrCreateTransporter().sendMail(mailOptions);
  }

  async sendPasswordResetCode(email: string, code: string): Promise<void> {
    const mailOptions = {
      from: this.resolveFrom(),
      to: email,
      subject: '密码重置验证码 - 文件分发系统',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">密码重置</h2>
          <p>您好，</p>
          <p>您的密码重置验证码是：<strong style="font-size: 24px; color: #0066FF;">${escapeHtml(code)}</strong></p>
          <p>验证码有效期为5分钟，请勿泄露给他人。</p>
          <p style="color: #666; font-size: 12px;">如果不是您本人操作，请忽略此邮件。</p>
        </div>
      `,
    };

    await this.getOrCreateTransporter().sendMail(mailOptions);
  }
}

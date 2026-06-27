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

  private getOrCreateTransporter(): nodemailer.Transporter {
    if (this.transporter) {
      return this.transporter;
    }
    return this.createTransporter({
      host: this.configService.get<string>('SMTP_HOST') || '',
      port: this.configService.get<number>('SMTP_PORT') || 587,
      secure: this.configService.get<boolean>('SMTP_SECURE') || false,
      user: this.configService.get<string>('SMTP_USER') || '',
      pass: decryptPassword(this.configService.get<string>('SMTP_PASSWORD') || ''),
    });
  }

  private createTransporter(config: SmtpConfig): nodemailer.Transporter {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
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
    const config = payload.value as SmtpConfig;
    if (config.pass) {
      config.pass = decryptPassword(config.pass);
    }
    this.transporter = null;
    this.createTransporter(config);
    this.logger.log('SMTP transporter 已根据配置更新重建');
  }

  async sendVerificationCode(email: string, code: string): Promise<void> {
    const mailOptions = {
      from: this.configService.get<string>('SMTP_FROM'),
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
      from: this.configService.get<string>('SMTP_FROM'),
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

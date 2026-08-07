import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigCacheService } from '../common/services/config-cache.service';
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
  from: string;
}

@Injectable()
export class MailerService {
  private transporter: nodemailer.Transporter | null = null;
  /** 当前 transporter 对应的配置快照（发件人解析、host 判空使用） */
  private currentConfig: SmtpConfig | null = null;
  private readonly logger = new Logger(MailerService.name);

  constructor(
    private configService: ConfigService,
    private configCacheService: ConfigCacheService,
  ) {}

  /** 严格解析字符串布尔值：仅 'true'（忽略大小写）为 true，'false'/空/其他均为 false */
  private parseBool(value: unknown): boolean {
    return String(value).toLowerCase() === 'true';
  }

  /**
   * 统一处理 SMTP 密码解密，空密码返回空字符串。
   * DB 中存储的是加密密文（admin 保存时 encryptPassword）；env 中的明文值
   * 不含 ':' 时经 decryptPassword 原样返回。解密失败时降级返回原值并告警，
   * 避免配置错误导致整个邮件链路不可用。
   */
  private resolveSmtpPassword(stored: string): string {
    if (!stored) return '';
    try {
      return decryptPassword(stored);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`SMTP 密码解密失败，降级使用原始值（请检查加密格式与 SMTP_ENCRYPTION_KEY/SALT）: ${message}`);
      return stored;
    }
  }

  /** 单项配置解析：DB（ConfigCacheService）优先，缺失时回退环境变量 */
  private async resolveConfigValue(key: string): Promise<string> {
    const dbValue = await this.configCacheService.get(key, '');
    if (dbValue) return dbValue;
    return this.configService.get<string>(key) || '';
  }

  /** 组装当前生效的 SMTP 配置：DB 优先、env 兜底，密码统一解密 */
  async loadSmtpConfig(): Promise<SmtpConfig> {
    const [host, portRaw, secureRaw, user, passRaw, from] = await Promise.all([
      this.resolveConfigValue('SMTP_HOST'),
      this.resolveConfigValue('SMTP_PORT'),
      this.resolveConfigValue('SMTP_SECURE'),
      this.resolveConfigValue('SMTP_USER'),
      this.resolveConfigValue('SMTP_PASSWORD'),
      this.resolveConfigValue('SMTP_FROM'),
    ]);

    const port = parseInt(portRaw, 10);
    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      // env 字符串 'false' 为 truthy，必须严格解析，否则 587 STARTTLS 会误用 secure=true 连接失败
      secure: this.parseBool(secureRaw),
      user,
      pass: this.resolveSmtpPassword(passRaw),
      from,
    };
  }

  private async getOrCreateTransporter(): Promise<nodemailer.Transporter> {
    if (this.transporter) {
      return this.transporter;
    }
    const config = await this.loadSmtpConfig();
    return this.createTransporter(config);
  }

  private createTransporter(config: SmtpConfig): nodemailer.Transporter {
    // 重建前先关闭旧连接池，避免泄漏残留连接
    if (this.transporter) {
      try {
        this.transporter.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`关闭旧 SMTP transporter 失败: ${message}`);
      }
    }
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
      // 超时兜底：host 配置错误时快速失败，避免长时间挂起
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    this.currentConfig = config;
    return this.transporter;
  }

  /**
   * 配置变更时销毁缓存的 transporter，下次发信按最新配置重建。
   * 事件处理器内抛错会传播回 ConfigCacheService.set/setBatch，
   * 导致配置已入库却返回 500，此处全部捕获并记录。
   */
  private invalidateTransporter(reason: string): void {
    try {
      if (this.transporter) {
        this.transporter.close();
        this.transporter = null;
        this.currentConfig = null;
      }
      this.logger.log(`检测到 SMTP 配置变更（${reason}），transporter 已标记重建`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`SMTP transporter 失效处理失败: ${message}`);
    }
  }

  /** 管理端批量保存（ConfigCacheService.setBatch）触发 */
  @OnEvent('config.batch-changed')
  handleConfigBatchChanged(configs: { key: string; value: string }[]): void {
    try {
      if (!Array.isArray(configs)) return;
      if (configs.some((c) => c.key && c.key.startsWith('SMTP_'))) {
        this.invalidateTransporter('config.batch-changed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`config.batch-changed 处理失败: ${message}`);
    }
  }

  /** 通用单键配置保存（ConfigCacheService.set）触发，覆盖 SMTP_ 前缀键 */
  @OnEvent('config.changed')
  handleConfigChanged(payload: { key: string; value: unknown }): void {
    try {
      if (payload?.key && payload.key.startsWith('SMTP_')) {
        this.invalidateTransporter('config.changed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`config.changed 处理失败: ${message}`);
    }
  }

  /** 发件人地址：优先 SMTP_FROM，回退 SMTP_USER，最后使用默认值，避免 from 为 undefined */
  private resolveFrom(): string {
    return this.currentConfig?.from || this.currentConfig?.user || 'noreply@localhost';
  }

  /** 获取 transporter 并校验 host 已配置，未配置时返回友好 503 */
  private async prepareSend(): Promise<nodemailer.Transporter> {
    const transporter = await this.getOrCreateTransporter();
    if (!this.currentConfig?.host) {
      throw new ServiceUnavailableException('邮件服务未配置，请联系管理员');
    }
    return transporter;
  }

  /** 捕获 nodemailer 错误：记录原始细节并转换为友好中文 503 */
  private async sendMailWithHandling(
    transporter: nodemailer.Transporter,
    mailOptions: { from: string; to: string; subject: string; html: string },
  ): Promise<void> {
    try {
      await transporter.sendMail(mailOptions);
    } catch (error) {
      const detail = error instanceof Error ? error.stack || error.message : String(error);
      this.logger.error(`邮件发送失败: ${detail}`);
      throw new ServiceUnavailableException(this.classifySmtpError(error));
    }
  }

  /** nodemailer 错误分类，映射为面向用户的友好中文提示 */
  private classifySmtpError(error: unknown): string {
    const err = error as { code?: string; message?: string; responseCode?: number };
    const code = err?.code || '';
    const message = err?.message || '';
    if (code === 'ENOTFOUND' || /getaddrinfo/i.test(message)) {
      return 'SMTP 服务器地址无法解析，请检查服务器地址是否正确';
    }
    if (code === 'ECONNREFUSED') {
      return 'SMTP 服务器拒绝连接，请检查端口与防火墙设置';
    }
    if (code === 'ETIMEDOUT' || code === 'ESOCKET' || /time ?d? ?out|超时/i.test(message)) {
      return '连接 SMTP 服务器超时，请检查网络或端口配置';
    }
    if (code === 'EAUTH' || err?.responseCode === 535 || /authentication|auth failed|invalid (user|password)|535/i.test(message)) {
      return 'SMTP 认证失败，请检查用户名和密码是否正确';
    }
    return '邮件发送失败，请检查 SMTP 配置（详细信息见后端日志）';
  }

  async sendVerificationCode(email: string, code: string): Promise<void> {
    const transporter = await this.prepareSend();
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

    await this.sendMailWithHandling(transporter, mailOptions);
  }

  async sendPasswordResetCode(email: string, code: string): Promise<void> {
    const transporter = await this.prepareSend();
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

    await this.sendMailWithHandling(transporter, mailOptions);
  }

  /**
   * 发送测试邮件：强制按当前生效配置（含刚保存未重启的 DB 配置）重建 transporter，
   * 先 verify() 连通性自检，再发送测试邮件。失败时按错误分类抛出友好 503。
   */
  async sendTestEmail(recipient: string): Promise<void> {
    // 强制重建，确保使用最新配置（管理端刚保存的 DB 配置在 ConfigCacheService 缓存中已更新）
    this.invalidateTransporter('测试发送前强制刷新');
    const transporter = await this.getOrCreateTransporter();
    if (!this.currentConfig?.host) {
      throw new ServiceUnavailableException('邮件服务未配置，请联系管理员');
    }

    try {
      await transporter.verify();
    } catch (error) {
      const detail = error instanceof Error ? error.stack || error.message : String(error);
      this.logger.error(`SMTP 连通性自检失败: ${detail}`);
      throw new ServiceUnavailableException(this.classifySmtpError(error));
    }

    const mailOptions = {
      from: this.resolveFrom(),
      to: recipient,
      subject: '测试邮件 - SMTP 配置验证',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">SMTP 配置验证成功</h2>
          <p>您好，</p>
          <p>这是一封测试邮件，用于验证 SMTP 邮件配置是否正确。</p>
          <p>发送时间：<strong>${escapeHtml(new Date().toLocaleString('zh-CN'))}</strong></p>
          <p style="color: #666; font-size: 12px;">如果您收到此邮件，说明当前 SMTP 配置工作正常。</p>
        </div>
      `,
    };

    await this.sendMailWithHandling(transporter, mailOptions);
    this.logger.log(`SMTP 测试邮件已发送至 ${recipient}`);
  }
}

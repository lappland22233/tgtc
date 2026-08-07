// crypto.util 依赖环境变量派生密钥，必须在任何加解密调用前设置
process.env.SMTP_ENCRYPTION_KEY = 'unit-test-encryption-key';
process.env.SMTP_ENCRYPTION_SALT = 'unit-test-encryption-salt';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

import * as nodemailer from 'nodemailer';
import { ServiceUnavailableException } from '@nestjs/common';
import { MailerService } from './mailer.service';
import { encryptPassword } from '../common/utils/crypto.util';

/** 构造可分别控制 DB 与 env 取值的 MailerService 实例 */
function buildService(dbValues: Record<string, string>, envValues: Record<string, string> = {}) {
  const configService = {
    get: jest.fn((key: string) => envValues[key]),
  };
  const configCacheService = {
    get: jest.fn(async (key: string, defaultValue: string) => dbValues[key] ?? defaultValue),
  };
  const service = new MailerService(configService as any, configCacheService as any);
  return { service, configService, configCacheService };
}

function buildMockTransporter(overrides: Record<string, jest.Mock> = {}) {
  return {
    sendMail: jest.fn().mockResolvedValue({}),
    verify: jest.fn().mockResolvedValue(true),
    close: jest.fn(),
    ...overrides,
  };
}

describe('MailerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadSmtpConfig 配置组装（DB 优先，env 兜底）', () => {
    it('DB 中存在的键优先于环境变量，密码经解密还原', async () => {
      const encrypted = encryptPassword('db-secret-pass');
      const { service } = buildService(
        {
          SMTP_HOST: 'smtp.db.com',
          SMTP_PASSWORD: encrypted,
        },
        {
          SMTP_HOST: 'smtp.env.com',
          SMTP_PORT: '465',
          SMTP_SECURE: 'true',
          SMTP_USER: 'env-user@example.com',
          SMTP_PASSWORD: 'env-pass',
          SMTP_FROM: 'from@env.com',
        },
      );

      const config = await service.loadSmtpConfig();
      expect(config.host).toBe('smtp.db.com');
      expect(config.pass).toBe('db-secret-pass');
      // DB 缺失项回退 env
      expect(config.port).toBe(465);
      expect(config.secure).toBe(true);
      expect(config.user).toBe('env-user@example.com');
      expect(config.from).toBe('from@env.com');
    });

    it('DB 全部缺失时完全回退环境变量，端口非法时回退默认 587', async () => {
      const { service } = buildService(
        {},
        { SMTP_HOST: 'smtp.env.com', SMTP_PORT: 'not-a-number', SMTP_SECURE: 'false', SMTP_USER: 'u' },
      );

      const config = await service.loadSmtpConfig();
      expect(config.host).toBe('smtp.env.com');
      expect(config.port).toBe(587);
      expect(config.secure).toBe(false);
      expect(config.pass).toBe('');
    });

    it('SMTP_SECURE 字符串 false 严格解析为 false（避免 truthy 误判）', async () => {
      const { service } = buildService({ SMTP_SECURE: 'false', SMTP_HOST: 'h' });
      const config = await service.loadSmtpConfig();
      expect(config.secure).toBe(false);
    });
  });

  describe('配置变更事件热更新', () => {
    it('config.batch-changed 含 SMTP_* 键时销毁缓存 transporter', async () => {
      const mockTransporter = buildMockTransporter();
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com', SMTP_USER: 'u', SMTP_PASSWORD: encryptPassword('p') });

      await (service as any).getOrCreateTransporter();
      expect((service as any).transporter).toBe(mockTransporter);

      service.handleConfigBatchChanged([
        { key: 'SMTP_HOST', value: 'smtp.new.com' },
        { key: 'SMTP_PORT', value: '465' },
      ]);

      expect(mockTransporter.close).toHaveBeenCalled();
      expect((service as any).transporter).toBeNull();
    });

    it('config.batch-changed 不含 SMTP 键时不重建', async () => {
      const mockTransporter = buildMockTransporter();
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com' });

      await (service as any).getOrCreateTransporter();
      service.handleConfigBatchChanged([{ key: 'MAX_FILE_SIZE', value: '100' }]);

      expect((service as any).transporter).toBe(mockTransporter);
    });

    it('config.changed 单键 SMTP_* 变更同样触发重建', async () => {
      const mockTransporter = buildMockTransporter();
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com' });

      await (service as any).getOrCreateTransporter();
      service.handleConfigChanged({ key: 'SMTP_HOST', value: 'smtp.new.com' });

      expect((service as any).transporter).toBeNull();
    });
  });

  describe('发信错误分类', () => {
    it('未配置 host 时抛出 503 友好提示', async () => {
      const { service } = buildService({}, {});
      await expect(service.sendVerificationCode('a@b.com', '123456')).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(service.sendVerificationCode('a@b.com', '123456')).rejects.toThrow('邮件服务未配置');
    });

    it('认证失败映射为友好中文提示', async () => {
      const mockTransporter = buildMockTransporter({
        sendMail: jest.fn().mockRejectedValue(Object.assign(new Error('Invalid login: 535 Authentication failed'), { code: 'EAUTH' })),
      });
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com', SMTP_USER: 'u', SMTP_PASSWORD: encryptPassword('p') });

      await expect(service.sendVerificationCode('a@b.com', '123456')).rejects.toThrow('SMTP 认证失败');
    });

    it('DNS 解析失败映射为友好中文提示', async () => {
      const mockTransporter = buildMockTransporter({
        sendMail: jest.fn().mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.bad.com'), { code: 'ENOTFOUND' })),
      });
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.bad.com', SMTP_USER: 'u', SMTP_PASSWORD: encryptPassword('p') });

      await expect(service.sendVerificationCode('a@b.com', '123456')).rejects.toThrow('地址无法解析');
    });

    it('连接超时映射为友好中文提示', async () => {
      const mockTransporter = buildMockTransporter({
        sendMail: jest.fn().mockRejectedValue(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })),
      });
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com', SMTP_USER: 'u', SMTP_PASSWORD: encryptPassword('p') });

      await expect(service.sendVerificationCode('a@b.com', '123456')).rejects.toThrow('超时');
    });

    it('创建 transporter 时携带超时参数与连接池', async () => {
      const mockTransporter = buildMockTransporter();
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com' });

      await service.sendVerificationCode('a@b.com', '123456');
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          pool: true,
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 15000,
        }),
      );
    });
  });

  describe('sendTestEmail 测试发信', () => {
    it('先 verify 自检再发送测试邮件', async () => {
      const mockTransporter = buildMockTransporter();
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com', SMTP_USER: 'u', SMTP_FROM: 'noreply@db.com' });

      await service.sendTestEmail('admin@example.com');

      expect(mockTransporter.verify).toHaveBeenCalled();
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@example.com',
          subject: '测试邮件 - SMTP 配置验证',
        }),
      );
    });

    it('未配置 host 时拒绝发送并抛出 503', async () => {
      const { service } = buildService({}, {});
      await expect(service.sendTestEmail('admin@example.com')).rejects.toThrow('邮件服务未配置');
    });

    it('verify 失败时按错误分类抛出友好 503', async () => {
      const mockTransporter = buildMockTransporter({
        verify: jest.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ECONNREFUSED' })),
      });
      (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);
      const { service } = buildService({ SMTP_HOST: 'smtp.db.com', SMTP_USER: 'u' });

      await expect(service.sendTestEmail('admin@example.com')).rejects.toThrow('拒绝连接');
      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    it('测试发送前强制刷新 transporter，使用最新配置', async () => {
      const firstTransporter = buildMockTransporter();
      const secondTransporter = buildMockTransporter();
      (nodemailer.createTransport as jest.Mock)
        .mockReturnValueOnce(firstTransporter)
        .mockReturnValue(secondTransporter);

      const dbValues: Record<string, string> = { SMTP_HOST: 'smtp.db.com', SMTP_USER: 'u' };
      const { service, configCacheService } = buildService(dbValues);
      configCacheService.get.mockImplementation(async (key: string, def: string) => dbValues[key] ?? def);

      // 首次发信建立旧 transporter
      await (service as any).getOrCreateTransporter();
      expect((service as any).transporter).toBe(firstTransporter);

      // 测试发送应销毁旧 transporter 并按最新配置重建
      await service.sendTestEmail('admin@example.com');
      expect(firstTransporter.close).toHaveBeenCalled();
      expect(secondTransporter.verify).toHaveBeenCalled();
    });
  });
});

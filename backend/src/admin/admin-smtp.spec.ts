// crypto.util 依赖环境变量派生密钥，必须在任何加解密调用前设置
process.env.SMTP_ENCRYPTION_KEY = 'unit-test-encryption-key';
process.env.SMTP_ENCRYPTION_SALT = 'unit-test-encryption-salt';

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// FileService 依赖链含 file-type（ESM-only，jest CJS 环境无法解析），
// 且本测试仅关心 SMTP 逻辑，直接 mock 掉整个模块
jest.mock('../file/file.service', () => ({ FileService: class FileService {} }));

import { AdminService } from './admin.service';
import { SmtpTestDto, SmtpConfigDto } from './admin.dto';

/** AdminService 依赖较多，此处仅关心 SMTP 相关逻辑，其余依赖用空 mock 占位 */
function buildAdminService() {
  const repoMock = () => ({}) as any;
  const configCacheService = {
    get: jest.fn(async (_key: string, defaultValue: string) => defaultValue),
    setBatch: jest.fn(async (_configs: { key: string; value: string; description?: string }[]) => undefined),
    set: jest.fn(async () => undefined),
  };
  const auditService = { log: jest.fn() };
  const mailerService = { sendTestEmail: jest.fn(async () => undefined) };
  const service = new AdminService(
    repoMock(), // systemConfigRepository
    repoMock(), // bannedIPRepository
    repoMock(), // fileRepository
    repoMock(), // userRepository
    repoMock(), // accessLogRepository
    repoMock(), // accessLogRepo
    repoMock(), // auditLogRepo
    repoMock(), // telemetryRepo
    {} as any, // fileService
    configCacheService as any,
    auditService as any,
    {} as any, // exportService
    mailerService as any,
  );
  return { service, configCacheService, auditService, mailerService };
}

const mockUser = { id: 'user-1', email: 'admin@example.com' } as any;

const baseConfig = {
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  user: 'mailer@example.com',
  from: 'noreply@example.com',
};

describe('AdminService.updateSMTPConfig 密码处理', () => {
  it('提供新密码时加密后写入', async () => {
    const { service, configCacheService } = buildAdminService();

    await service.updateSMTPConfig(mockUser, { ...baseConfig, password: 'new-secret' });

    const saved = configCacheService.setBatch.mock.calls[0][0] as { key: string; value: string }[];
    const passwordEntry = saved.find((c) => c.key === 'SMTP_PASSWORD');
    expect(passwordEntry).toBeDefined();
    expect(passwordEntry!.value).toMatch(/^v2:/);
    expect(passwordEntry!.value).not.toContain('new-secret');
    // 未读取旧密码
    expect(configCacheService.get).not.toHaveBeenCalled();
  });

  it('密码留空时保留数据库中已有密文，不覆盖', async () => {
    const { service, configCacheService } = buildAdminService();
    const oldCipher = 'v2:iv:cipher:tag';
    configCacheService.get.mockResolvedValue(oldCipher);

    await service.updateSMTPConfig(mockUser, { ...baseConfig, password: '' });

    expect(configCacheService.get).toHaveBeenCalledWith('SMTP_PASSWORD', '');
    const saved = configCacheService.setBatch.mock.calls[0][0] as { key: string; value: string }[];
    const passwordEntry = saved.find((c) => c.key === 'SMTP_PASSWORD');
    expect(passwordEntry!.value).toBe(oldCipher);
  });

  it('密码字段未传（undefined）时同样保留旧密文', async () => {
    const { service, configCacheService } = buildAdminService();
    configCacheService.get.mockResolvedValue('v2:old');

    await service.updateSMTPConfig(mockUser, { ...baseConfig });

    const saved = configCacheService.setBatch.mock.calls[0][0] as { key: string; value: string }[];
    expect(saved.find((c) => c.key === 'SMTP_PASSWORD')!.value).toBe('v2:old');
  });

  it('保存成功后记录审计日志', async () => {
    const { service, auditService } = buildAdminService();
    await service.updateSMTPConfig(mockUser, { ...baseConfig, password: 'p' });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'smtp_config_change', userId: 'user-1' }),
    );
  });
});

describe('AdminService.sendTestSMTPMail', () => {
  it('委托 MailerService 发送并记录审计日志', async () => {
    const { service, mailerService, auditService } = buildAdminService();
    await service.sendTestSMTPMail(mockUser, 'to@example.com');
    expect(mailerService.sendTestEmail).toHaveBeenCalledWith('to@example.com');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'smtp_test_mail', metadata: { recipient: 'to@example.com' } }),
    );
  });

  it('MailerService 抛错时向上冒泡（由全局过滤器处理）', async () => {
    const { service, mailerService } = buildAdminService();
    mailerService.sendTestEmail.mockRejectedValue(new Error('SMTP 认证失败'));
    await expect(service.sendTestSMTPMail(mockUser, 'to@example.com')).rejects.toThrow('SMTP 认证失败');
  });
});

describe('SmtpTestDto 校验', () => {
  it('合法邮箱通过校验', async () => {
    const dto = plainToInstance(SmtpTestDto, { recipient: 'user@example.com' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('非法邮箱被拒绝', async () => {
    const dto = plainToInstance(SmtpTestDto, { recipient: 'not-an-email' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('recipient');
  });

  it('缺失 recipient 被拒绝', async () => {
    const dto = plainToInstance(SmtpTestDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SmtpConfigDto 密码可选', () => {
  it('不传 password 仍通过校验（二次保存无需重输密码）', async () => {
    const dto = plainToInstance(SmtpConfigDto, {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'mailer@example.com',
      from: 'noreply@example.com',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('password 传空字符串也通过校验', async () => {
    const dto = plainToInstance(SmtpConfigDto, {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'mailer@example.com',
      password: '',
      from: 'noreply@example.com',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('缺失必填字段仍被拒绝', async () => {
    const dto = plainToInstance(SmtpConfigDto, { port: 465 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

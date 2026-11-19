import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StorageBackendsController } from './storage-backends.controller';
import { UserRole } from '../common/entities/user.entity';

describe('StorageBackendsController - GDrive 凭据轮换与邮箱一致性校验', () => {
  const user = { id: 'admin-1', role: UserRole.SUPER_ADMIN } as any;

  function makeController(opts: {
    existingAccount?: any;
    exchanged?: { refreshToken: string; email?: string };
  }) {
    const backends = {
      findById: jest.fn().mockResolvedValue(opts.existingAccount ?? null),
      rotateCredential: jest.fn().mockResolvedValue({ id: opts.existingAccount?.id, name: opts.existingAccount?.name }),
      patchConfig: jest.fn().mockResolvedValue({}),
      refreshQuota: jest.fn().mockResolvedValue({ totalBytes: 100, usedBytes: 50 }),
    };
    const router = {} as any;
    const gdriveOAuth = {
      exchangeCode: jest.fn().mockResolvedValue(opts.exchanged ?? { refreshToken: 'new-token', email: 'test@example.com' }),
    };
    const configCache = {} as any;
    const audit = { log: jest.fn() } as any;

    const controller = new StorageBackendsController(
      backends as any,
      router,
      gdriveOAuth as any,
      configCache,
      audit,
    );

    return { controller, backends, gdriveOAuth, audit };
  }

  it('账号不存在时抛出 NotFoundException', async () => {
    const { controller } = makeController({ existingAccount: null });
    await expect(
      controller.gdriveRotateAuth(user, 'nonexistent', { code: 'c1', redirectUri: 'http://localhost' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('非 GDrive 账号拒绝轮换', async () => {
    const { controller } = makeController({
      existingAccount: { id: 's3-1', type: 's3', name: 'My S3' },
    });
    await expect(
      controller.gdriveRotateAuth(user, 's3-1', { code: 'c1', redirectUri: 'http://localhost' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('授权邮箱与已有账号邮箱不一致时抛出 BadRequestException（防误换为其他 Google 账号）', async () => {
    const { controller } = makeController({
      existingAccount: {
        id: 'gd-1',
        type: 'gdrive',
        name: 'My Drive',
        config: { email: 'original@gmail.com' },
      },
      exchanged: {
        refreshToken: 'new-refresh',
        email: 'different@gmail.com',
      },
    });

    await expect(
      controller.gdriveRotateAuth(user, 'gd-1', { code: 'c1', redirectUri: 'http://localhost' }),
    ).rejects.toThrow('授权邮箱与当前账号不一致，请使用原 Google 账号重新授权');
  });

  it('邮箱匹配时成功轮换凭据、刷新配额并记录审计日志', async () => {
    const { controller, backends, audit } = makeController({
      existingAccount: {
        id: 'gd-1',
        type: 'gdrive',
        name: 'My Drive',
        config: { email: 'original@gmail.com' },
      },
      exchanged: {
        refreshToken: 'new-refresh',
        email: 'original@gmail.com',
      },
    });

    const result = await controller.gdriveRotateAuth(user, 'gd-1', { code: 'c1', redirectUri: 'http://localhost' });
    expect(result.message).toContain('Google Drive 账号已重新授权并通过连通性测试');
    expect(backends.rotateCredential).toHaveBeenCalledWith('gd-1', { refreshToken: 'new-refresh' }, 'admin-1');
    expect(backends.refreshQuota).toHaveBeenCalledWith('gd-1');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'config_change',
      resourceType: 'storage_backend',
      resourceId: 'gd-1',
      metadata: { type: 'gdrive', operation: 'rotate_auth' },
    }));
  });
});

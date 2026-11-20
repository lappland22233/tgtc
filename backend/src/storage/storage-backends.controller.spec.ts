import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StorageBackendsController } from './storage-backends.controller';
import { UserRole } from '../common/entities/user.entity';

describe('StorageBackendsController - GDrive 凭据轮换与邮箱一致性校验', () => {
  const user = { id: 'admin-1', role: UserRole.SUPER_ADMIN } as any;

  function makeController(opts: {
    existingAccount?: any;
    exchanged?: { refreshToken: string; email?: string };
  } = {}) {
    const backends: any = {
      findById: jest.fn().mockResolvedValue(opts.existingAccount ?? null),
      list: jest.fn().mockResolvedValue([]),
      rotateCredential: jest.fn().mockResolvedValue({ id: opts.existingAccount?.id, name: opts.existingAccount?.name }),
      patchConfig: jest.fn().mockResolvedValue({}),
      refreshQuota: jest.fn().mockResolvedValue({ totalBytes: 100, usedBytes: 50 }),
      create: jest.fn().mockResolvedValue({ id: 'created-id', name: 'Created' }),
    };
    const router: any = { getDefaultBackendType: jest.fn().mockResolvedValue('telegram') };
    const gdriveOAuth: any = {
      exchangeCode: jest.fn().mockResolvedValue(opts.exchanged ?? { refreshToken: 'new-token', email: 'test@example.com' }),
      getClientConfig: jest.fn().mockResolvedValue(null),
      setClientConfig: jest.fn().mockResolvedValue(undefined),
      clearClientConfig: jest.fn().mockResolvedValue(undefined),
    };
    const configCache: any = { get: jest.fn(), set: jest.fn() };
    const audit: any = { log: jest.fn() };
    const user: any = { id: 'u-1', role: 'super_admin' };

    const controller = new StorageBackendsController(
      backends as any,
      router,
      gdriveOAuth as any,
      configCache,
      audit,
    );

    return { controller, backends, gdriveOAuth, configCache, router, audit, user };
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

  it('gdriveCompleteAuth：未传 name 时自动以 GDrive (邮箱) 命名', async () => {
    const { controller, backends } = makeController({
      exchanged: { refreshToken: 'rt-1', email: 'pool-user@gmail.com' },
    });
    backends.create = jest.fn().mockResolvedValue({ id: 'gd-new', name: 'GDrive (pool-user@gmail.com)' });

    const result = await controller.gdriveCompleteAuth(user, {
      code: 'code-1',
      redirectUri: 'http://localhost/callback',
    } as any);

    expect(result.message).toContain('Google Drive 账号授权成功');
    expect(backends.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gdrive',
        name: 'GDrive (pool-user@gmail.com)',
        config: { email: 'pool-user@gmail.com' },
        credential: { refreshToken: 'rt-1' },
      }),
      'admin-1',
    );
  });

  it('getGDriveOAuthClient & setGDriveOAuthClient：包含并保存 redirectUri', async () => {
    const { controller, gdriveOAuth, audit } = makeController({});
    gdriveOAuth.getClientConfig = jest.fn().mockResolvedValue({
      clientId: 'client-id',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:5173/admin/storage-backends/gdrive-callback',
    });
    gdriveOAuth.setClientConfig = jest.fn().mockResolvedValue(undefined);

    const info = await controller.getGDriveOAuthClient();
    expect(info).toEqual({
      configured: true,
      clientId: 'client-id',
      redirectUri: 'http://localhost:5173/admin/storage-backends/gdrive-callback',
    });

    const setResult = await controller.setGDriveOAuthClient(user, {
      clientId: 'new-id',
      clientSecret: 'new-secret',
      redirectUri: 'https://mysite.com/callback',
    });
    expect(setResult.message).toContain('Google Drive OAuth Client 已保存');
    expect(gdriveOAuth.setClientConfig).toHaveBeenCalledWith(
      'new-id',
      'new-secret',
      'https://mysite.com/callback',
    );
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'config_change',
      resourceId: 'gdrive_oauth_client',
      metadata: expect.objectContaining({ hasRedirectUri: true }),
    }));
  });

  it('updateSettings 支持热更新 Google 缓存模式与分块大小', async () => {
    const { controller, configCache, user, router, audit } = makeController();
    router.getDefaultBackendType = jest.fn().mockResolvedValue('telegram');
    configCache.get = jest.fn(async (key: string, fallback: string) => {
      if (key === 'STORAGE_GDRIVE_CACHE_MODE') return 'true';
      if (key === 'STORAGE_GDRIVE_CHUNK_SIZE_MB') return '32';
      return fallback;
    });

    const result = await controller.updateSettings(user, {
      backend: 'telegram',
      gdriveCacheMode: true,
      gdriveChunkSizeMb: 32,
    });

    expect(result).toMatchObject({
      success: true,
      defaultBackend: 'telegram',
      gdriveCacheMode: true,
      gdriveChunkSizeMb: 32,
    });
    expect(configCache.set).toHaveBeenCalledWith('STORAGE_DEFAULT_BACKEND', 'telegram', expect.any(String));
    expect(configCache.set).toHaveBeenCalledWith('STORAGE_GDRIVE_CACHE_MODE', 'true', expect.any(String));
    expect(configCache.set).toHaveBeenCalledWith('STORAGE_GDRIVE_CHUNK_SIZE_MB', '32', expect.any(String));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'config_change',
      resourceId: 'storage_settings',
    }));
  });

  it('clearGDriveOAuthClient：存在未撤销的活跃 GDrive 账号时拒绝清空', async () => {
    const { controller, backends, gdriveOAuth } = makeController();
    backends.list = jest.fn().mockResolvedValue([
      { id: 'gd-1', type: 'gdrive', status: 'active', hasCredential: true },
    ]);

    await expect(controller.clearGDriveOAuthClient(user)).rejects.toThrow(
      '当前仍有 1 个未撤销的 Google Drive 存储账号依赖此 OAuth Client 配置，无法清空',
    );
    expect(gdriveOAuth.clearClientConfig).not.toHaveBeenCalled();
  });

  it('clearGDriveOAuthClient：账号已全部撤销（无凭据残留）或无账号时允许清空', async () => {
    const { controller, backends, gdriveOAuth, audit } = makeController();
    // 模拟仅存在被管理员撤销软删除的 GDrive 账号
    backends.list = jest.fn().mockResolvedValue([
      { id: 'gd-revoked', type: 'gdrive', status: 'revoked', hasCredential: false },
    ]);

    const result = await controller.clearGDriveOAuthClient(user);
    expect(result.message).toContain('已清除');
    expect(gdriveOAuth.clearClientConfig).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'config_change',
      resourceId: 'gdrive_oauth_client',
      metadata: { operation: 'clear' },
    }));
  });
});

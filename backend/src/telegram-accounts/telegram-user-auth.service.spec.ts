import { TelegramUserClientError } from '../telegram-user/telegram-user-client.service';
import { TelegramUserAuthService } from './telegram-user-auth.service';

describe('TelegramUserAuthService（交互式授权）', () => {
  const accountRow = {
    id: 'acc-1',
    type: 'user',
    primaryChatId: '-100222',
  };

  function setup(options: {
    payload?: Record<string, unknown>;
    clientAvailable?: boolean;
  } = {}) {
    const payload = options.payload ?? {
      apiId: 12345,
      apiHash: 'api-hash-value',
      phoneNumber: '+8613800000000',
      session: '',
    };
    const accounts = {
      resolveCredential: jest.fn(async () => ({ account: accountRow, payload })),
      completeUserAuthorization: jest.fn(async () => ({ status: 'active' })),
      recordAuthFailure: jest.fn(async () => undefined),
    };
    const userClient = {
      isAvailable: () => options.clientAvailable ?? true,
      unavailableReason: () => (options.clientAvailable === false ? '依赖未安装' : null),
      sendLoginCode: jest.fn(async () => ({
        phoneCodeHash: 'HASH-1',
        isCodeViaApp: true,
        session: 'INTERIM-SESSION',
      })),
      signIn: jest.fn(async () => ({
        identity: { userId: '700123456', username: 'demo' },
        session: 'AUTHORIZED-SESSION',
      })),
      checkChatAccess: jest.fn(async () => ({ chatId: '-100222', title: '备份群', type: 'channel', canWrite: true })),
    };
    const audit = { log: jest.fn() };
    const service = new TelegramUserAuthService(accounts as never, userClient as never, audit as never);
    return { service, accounts, userClient, audit };
  }

  it('发送验证码：使用账号凭据中的手机号并记录待授权会话', async () => {
    const { service, userClient, audit } = setup();
    const result = await service.start('acc-1', {}, 'admin-1');

    expect(userClient.sendLoginCode).toHaveBeenCalledWith(
      { apiId: 12345, apiHash: 'api-hash-value', session: '' },
      '+8613800000000',
      false,
    );
    expect(result.phoneMasked).toBe('+8***00');
    expect(result.isCodeViaApp).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'telegram_account_auth_started' }));
    // 手机号只以脱敏形式进入审计
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('1380000');
  });

  it('提交验证码：复用中间态 session 完成授权，只保存服务端返回的 session', async () => {
    const { service, userClient, accounts } = setup();
    await service.start('acc-1', {}, 'admin-1');
    const result = await service.verify('acc-1', { code: '12345' }, 'admin-1');

    expect(userClient.signIn).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { apiId: 12345, apiHash: 'api-hash-value', session: 'INTERIM-SESSION' },
      phoneNumber: '+8613800000000',
      phoneCodeHash: 'HASH-1',
      code: '12345',
    }));
    expect(accounts.completeUserAuthorization).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ session: 'AUTHORIZED-SESSION', identity: { userId: '700123456', username: 'demo' } }),
      'admin-1',
    );
    expect(result).toEqual({ ok: true, status: 'active' });
  });

  it('未发送验证码直接提交：拒绝且不调用授权', async () => {
    const { service, userClient } = setup();
    await expect(service.verify('acc-1', { code: '12345' }, 'admin-1')).rejects.toThrow(/授权会话不存在/);
    expect(userClient.signIn).not.toHaveBeenCalled();
  });

  it('授权失败：记录失败但审计不包含验证码与 2FA 密码', async () => {
    const { service, userClient, accounts, audit } = setup();
    userClient.signIn.mockRejectedValueOnce(new TelegramUserClientError('PHONE_CODE_INVALID', 'auth'));
    await service.start('acc-1', {}, 'admin-1');

    await expect(service.verify('acc-1', { code: '99999', password: 'my-2fa-password' }, 'admin-1'))
      .rejects.toThrow(/授权失败/);

    expect(accounts.recordAuthFailure).toHaveBeenCalledWith(
      'acc-1',
      'auth_verify_failed',
      expect.any(String),
      'admin-1',
    );
    const auditPayload = JSON.stringify(audit.log.mock.calls);
    expect(auditPayload).not.toContain('99999');
    expect(auditPayload).not.toContain('my-2fa-password');
  });

  it('MTProto 依赖不可用：fail-closed 拒绝发起授权，并给出可诊断原因', async () => {
    const { service } = setup({ clientAvailable: false });
    await expect(service.start('acc-1', {}, 'admin-1')).rejects.toThrow(/MTProto 客户端不可用/);
  });

  it('取消授权：清理进程内中间态，取消后必须重新发送验证码', async () => {
    const { service } = setup();
    await service.start('acc-1', {}, 'admin-1');
    expect(service.cancel('acc-1')).toEqual({ ok: true });
    await expect(service.verify('acc-1', { code: '12345' }, 'admin-1')).rejects.toThrow(/授权会话不存在/);
  });
});

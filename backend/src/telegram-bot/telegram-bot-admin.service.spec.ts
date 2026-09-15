import { TelegramBotAdminService } from './telegram-bot-admin.service';

function makeService(envValues: Record<string, string | undefined> = {}) {
  const configService = { get: jest.fn((key: string) => envValues[key]) };
  const auditService = { log: jest.fn() };
  const grantService = {
    tokenPrefixOf: (token: string) => `tgl_${token.slice(0, 8)}`,
    findByToken: jest.fn(),
    revoke: jest.fn(),
    isActive: jest.fn(),
    listActiveByUser: jest.fn(async () => [] as Array<Record<string, unknown>>),
    replayToken: jest.fn(),
    buildUrl: jest.fn((origin: string, token: string) => `${origin}/api/bot-dl/${token}`),
  };
  const quotaService = {} as never;
  const configServiceForDomain = { resolveSiteOriginAsync: jest.fn(async () => 'https://example.com') };
  const dataSource = {} as never;
  const service = new TelegramBotAdminService(
    configService as never,
    auditService as never,
    grantService as never,
    quotaService,
    configServiceForDomain as never,
    dataSource,
  );
  return { service, auditService, grantService, configServiceForDomain };
}

describe('TelegramBotAdminService', () => {
  it('管理员集合仅接受纯数字 TG 用户 ID（username 不参与权限判定）', () => {
    const { service } = makeService({ TELEGRAM_BOT_ADMIN_IDS: '111, 222,abc, @someone, ' });
    expect(service.isAdmin('111')).toBe(true);
    expect(service.isAdmin('222')).toBe(true);
    expect(service.isAdmin('abc')).toBe(false);
    expect(service.isAdmin('@someone')).toBe(false);
    expect(service.isAdmin('333')).toBe(false);
  });

  it('从完整直链或裸 Token 中提取 Token，非法输入返回 null', () => {
    const { service } = makeService({});
    const token = 'A'.repeat(43);
    expect(service.extractToken(`https://example.com/api/bot-dl/${token}`)).toBe(token);
    expect(service.extractToken(token)).toBe(token);
    expect(service.extractToken('https://example.com/api/bot-dl/')).toBeNull();
    expect(service.extractToken('short')).toBeNull();
    expect(service.extractToken('')).toBeNull();
    expect(service.extractToken('not-a-url/@@@')).toBeNull();
  });

  it('越权调用管理命令写入审计（含命令名，不含敏感内容）', () => {
    const { service, auditService } = makeService({});
    service.auditCommandDenied(
      { telegramUserId: '999', username: '@x', displayName: 'X' },
      '/link_query',
      'private',
    );
    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'telegram_bot_command_denied',
      resourceId: '/link_query',
      status: 'failure',
    }));
  });

  it('/link_query 审计只记录命中条数，不记录完整链接', async () => {
    const { service, auditService, grantService } = makeService({});
    grantService.listActiveByUser.mockResolvedValue([
      {
        id: 'g1',
        tokenPrefix: 'tgl_abcdefgh',
        fileName: 'a.bin',
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
      },
    ]);
    grantService.replayToken.mockReturnValue('T'.repeat(43));

    const results = await service.queryLinks(
      { telegramUserId: '111', username: '@admin', displayName: 'A' },
      '222',
    );
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe(`https://example.com/api/bot-dl/${'T'.repeat(43)}`);

    const auditPayload = auditService.log.mock.calls[0][0];
    expect(auditPayload.action).toBe('telegram_bot_link_queried');
    expect(JSON.stringify(auditPayload)).not.toContain('T'.repeat(43));
    expect(auditPayload.metadata).toMatchObject({ targetTelegramUserId: '222', hitCount: 1, replayable: 1 });
  });

  it('未启用加密存储时查询返回前缀与空链接（降级提示）', async () => {
    const { service, grantService } = makeService({});
    grantService.listActiveByUser.mockResolvedValue([
      { id: 'g2', tokenPrefix: 'tgl_zzzzzzzz', fileName: null, expiresAt: new Date(Date.now() + 3600_000), revokedAt: null },
    ]);
    grantService.replayToken.mockReturnValue(null);
    const results = await service.queryLinks(
      { telegramUserId: '111', username: null, displayName: null },
      '222',
    );
    expect(results[0].url).toBeNull();
    expect(results[0].prefix).toBe('tgl_zzzzzzzz');
  });

  it('/link_revoke 审计只记录 grantId 与前缀', async () => {
    const { service, auditService, grantService } = makeService({});
    const token = 'B'.repeat(43);
    grantService.findByToken.mockResolvedValue({
      id: 'grant-1',
      tokenPrefix: 'tgl_bbbbbbbb',
      telegramUserId: '222',
      revokedAt: null,
    });
    grantService.revoke.mockResolvedValue(true);

    const result = await service.revokeByToken(
      { telegramUserId: '111', username: '@admin', displayName: null },
      `https://example.com/api/bot-dl/${token}`,
    );
    expect(result.ok).toBe(true);
    const auditPayload = auditService.log.mock.calls[0][0];
    expect(auditPayload.action).toBe('telegram_bot_link_revoked');
    expect(JSON.stringify(auditPayload)).not.toContain(token);
    expect(auditPayload.metadata.tokenPrefix).toBe('tgl_bbbbbbbb');
  });
});

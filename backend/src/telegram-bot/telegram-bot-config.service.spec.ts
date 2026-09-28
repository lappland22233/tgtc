import { BadRequestException } from '@nestjs/common';
import { TelegramBotConfigService } from './telegram-bot-config.service';

function makeService(envValues: Record<string, string | undefined>, cacheValues: Record<string, string> = {}) {
  const configCacheService = {
    get: jest.fn(async (key: string, fallback: string) => cacheValues[key] ?? fallback),
    setBatch: jest.fn(async (_configs: { key: string; value: string; description?: string }[]) => undefined),
  };
  const configService = { get: jest.fn((key: string) => envValues[key]) };
  const service = new TelegramBotConfigService(configCacheService as never, configService as never);
  return { service, configCacheService };
}

describe('TelegramBotConfigService', () => {
  const originalHops = process.env.TRUST_PROXY_HOPS;

  afterEach(() => {
    if (originalHops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = originalHops;
  });

  it('读取配置时使用 env 兜底默认值', async () => {
    const { service } = makeService({});
    const config = await service.getConfig();
    expect(config).toEqual({
      linkTtlHours: 4,
      dailyLimit: 5,
      quotaTimezone: 'Asia/Shanghai',
      linkDomainMode: 'auto',
      linkDomain: '',
    });
  });

  it('面板值优先于 env 兜底值', async () => {
    const { service } = makeService(
      { TELEGRAM_BOT_LINK_TTL_HOURS: '8', TELEGRAM_BOT_DAILY_LIMIT: '20' },
      { TELEGRAM_BOT_LINK_TTL_HOURS: '2', TELEGRAM_BOT_DAILY_LIMIT: '7' },
    );
    const config = await service.getConfig();
    expect(config.linkTtlHours).toBe(2);
    expect(config.dailyLimit).toBe(7);
  });

  it('拒绝越界的有效期与额度', async () => {
    const { service } = makeService({});
    await expect(service.updateConfig({ linkTtlHours: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateConfig({ linkTtlHours: 721 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateConfig({ dailyLimit: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateConfig({ dailyLimit: 100001 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('拒绝非法时区、域名模式与含路径的域名', async () => {
    const { service } = makeService({});
    await expect(service.updateConfig({ quotaTimezone: 'Not/AZone' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateConfig({ linkDomainMode: 'random' as never })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateConfig({ linkDomain: 'https://example.com/path' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateConfig({ linkDomain: 'javascript:alert(1)' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('合法配置写入 ConfigCache（热更新通道）', async () => {
    const { service, configCacheService } = makeService({});
    const next = await service.updateConfig({
      linkTtlHours: 6,
      dailyLimit: 9,
      quotaTimezone: 'UTC',
      linkDomainMode: 'manual',
      linkDomain: 'https://text.lappland.top',
    });
    expect(next).toMatchObject({ linkTtlHours: 6, dailyLimit: 9, linkDomainMode: 'manual' });
    expect(configCacheService.setBatch).toHaveBeenCalledTimes(1);
    const writtenKeys = configCacheService.setBatch.mock.calls[0][0].map((item) => item.key);
    expect(writtenKeys).toContain('TELEGRAM_BOT_LINK_TTL_HOURS');
    expect(writtenKeys).toContain('TELEGRAM_BOT_LINK_DOMAIN');
  });

  it('手动模式使用面板域名，非法值 fail-closed', async () => {
    const manual = makeService({}, {
      TELEGRAM_BOT_LINK_DOMAIN_MODE: 'manual',
      TELEGRAM_BOT_LINK_DOMAIN: 'https://text.lappland.top/',
    });
    await expect(manual.service.resolveSiteOriginAsync()).resolves.toBe('https://text.lappland.top');

    const invalid = makeService({}, {
      TELEGRAM_BOT_LINK_DOMAIN_MODE: 'manual',
      TELEGRAM_BOT_LINK_DOMAIN: 'https://text.lappland.top/some/path',
    });
    await expect(invalid.service.resolveSiteOriginAsync()).resolves.toBeNull();
  });

  it('自动模式优先 APP_URL；无可信来源时 fail-closed（不回退 localhost/裸 Host）', async () => {
    const withAppUrl = makeService({ APP_URL: 'https://text.lappland.top' });
    await expect(withAppUrl.service.resolveSiteOriginAsync()).resolves.toBe('https://text.lappland.top');

    delete process.env.TRUST_PROXY_HOPS;
    const noSource = makeService({});
    await expect(noSource.service.resolveSiteOriginAsync()).resolves.toBeNull();
    expect(noSource.service.detectDomainFromRequest({} as never)).toBeNull();
  });

  it('仅在 TRUST_PROXY_HOPS>=1 时采信代理头推导的域名', async () => {
    process.env.TRUST_PROXY_HOPS = '0';
    const untrusted = makeService({});
    expect(untrusted.service.detectDomainFromRequest({ protocol: 'https', hostname: 'evil.example' } as never)).toBeNull();

    process.env.TRUST_PROXY_HOPS = '1';
    const trusted = makeService({});
    // trust proxy 开启时 Express 已按可信链解析 protocol/hostname
    process.env.TRUST_PROXY_HOPS = '1';
    expect(trusted.service.detectDomainFromRequest({ protocol: 'https', hostname: 'text.lappland.top' } as never))
      .toBe('https://text.lappland.top');
  });
});

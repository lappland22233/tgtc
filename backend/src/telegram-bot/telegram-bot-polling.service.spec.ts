import { ConfigService } from '@nestjs/config';
import { BOT_UPDATE_OFFSET_KEY, BOT_UPDATE_OFFSET_OWNER_KEY } from './telegram-bot.types';
import { TelegramBotPollingService } from './telegram-bot-polling.service';

/**
 * 池化模式下 offset 的继承语义。
 *
 * 回归背景：主 Bot（`TELEGRAM_BOT_TOKEN`）在 1.5.3 起始终注册进账号池，
 * 从「单账号模式」切到「池化模式」时账号级 offset 键是全新的（0），
 * 若不继承历史全局 offset，Telegram 会重放约 24 小时的更新
 * （重复下载、重复回复、重复登记副本）。
 */
function makeService(options: {
  env?: Record<string, string>;
  stored?: Record<string, string>;
  accountIds?: string[];
  primaryAccountId?: string | null;
}) {
  const store = new Map<string, string>(Object.entries(options.stored ?? {}));
  const writes: Array<{ key: string; value: string }> = [];
  const configCache = {
    get: jest.fn(async (key: string, fallback: string) => store.get(key) ?? fallback),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      writes.push({ key, value });
    }),
  };
  const configService = {
    get: jest.fn((key: string) => options.env?.[key]),
  } as unknown as ConfigService;
  const pool = {
    isActive: () => true,
    ids: () => options.accountIds ?? ['123456'],
    getConfig: () => ({ token: '123456:TOKEN', chatId: '-1' }),
    primaryAccountId: () => (options.primaryAccountId === undefined ? '123456' : options.primaryAccountId),
  };
  const accountClient = {
    // 循环立刻失败 → 进入退避等待，关闭时能快速退出（不产生真实网络调用）
    getUpdates: jest.fn(async () => {
      throw new Error('测试桩：停止轮询');
    }),
    getWebhookInfo: jest.fn(async () => ({ url: '' })),
  };
  const service = new TelegramBotPollingService(
    { getWebhookInfo: jest.fn(async () => ({ url: '' })) } as never,
    { handleUpdate: jest.fn() } as never,
    configCache as never,
    configService,
    pool as never,
    accountClient as never,
  );
  return { service, store, writes };
}

describe('TelegramBotPollingService（池化 offset）', () => {
  it('主 Bot 首次进入池化模式时继承历史全局 offset', async () => {
    const { service, store, writes } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_POLL_TIMEOUT_SECONDS: '1' },
      stored: { [BOT_UPDATE_OFFSET_KEY]: '7788' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    expect(store.get(`${BOT_UPDATE_OFFSET_KEY}:123456`)).toBe('7788');
    expect(writes).toContainEqual({ key: `${BOT_UPDATE_OFFSET_KEY}:123456`, value: '7788' });
    await service.onApplicationShutdown();
  });

  it('账号级 offset 已有进度时不覆盖（不倒退、不重放）', async () => {
    const accountKey = `${BOT_UPDATE_OFFSET_KEY}:123456`;
    const { service, store } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true' },
      stored: { [BOT_UPDATE_OFFSET_KEY]: '7788', [accountKey]: '9000' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    expect(store.get(accountKey)).toBe('9000');
    await service.onApplicationShutdown();
  });

  it('非主 Bot 账号不继承全局 offset（每账号 offset 必须独立）', async () => {
    const { service, store } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true' },
      stored: { [BOT_UPDATE_OFFSET_KEY]: '7788' },
      accountIds: ['999'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    expect(store.has(`${BOT_UPDATE_OFFSET_KEY}:999`)).toBe(false);
    await service.onApplicationShutdown();
  });

  it('归属标记指向该账号时继承全局 offset（即使它不是主 Bot）', async () => {
    const { service, store } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true' },
      stored: { [BOT_UPDATE_OFFSET_KEY]: '7788', [BOT_UPDATE_OFFSET_OWNER_KEY]: '999' },
      accountIds: ['999'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    expect(store.get(`${BOT_UPDATE_OFFSET_KEY}:999`)).toBe('7788');
    await service.onApplicationShutdown();
  });

  it('归属标记指向其它账号时不继承（否则会跳过该账号尚未消费的更新）', async () => {
    const { service, store } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true' },
      stored: { [BOT_UPDATE_OFFSET_KEY]: '7788', [BOT_UPDATE_OFFSET_OWNER_KEY]: '555' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    expect(store.has(`${BOT_UPDATE_OFFSET_KEY}:123456`)).toBe(false);
    await service.onApplicationShutdown();
  });
});

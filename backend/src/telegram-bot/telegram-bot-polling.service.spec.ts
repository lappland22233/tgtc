import { Logger } from '@nestjs/common';
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
/** 短延迟桩：让循环稳定停在 await 上（既不忙循环，也能毫秒级关闭） */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function makeService(options: {
  env?: Record<string, string>;
  stored?: Record<string, string>;
  accountIds?: string[];
  primaryAccountId?: string | null;
  /** 账号池是否生效；`false` 走单账号路径 */
  pooled?: boolean;
  /** 可变引用：用于在运行期改变 `pool.isActive()`（验证 modeDrift） */
  poolActive?: { value: boolean };
  /** 每次轮询的模拟长轮询耗时（毫秒） */
  pollDelayMs?: number;
  /** 让 getUpdates 立即抛错（错误文案里含字面 Token，用于验证脱敏） */
  failPolling?: boolean;
  /** 按调用序号返回的更新批次（用完后返回空数组） */
  updateBatches?: Array<Array<Record<string, unknown>>>;
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
  const poolActive = options.poolActive ?? { value: options.pooled !== false };
  /** 可变引用：用于验证「运行期账号集合变化」被 modeDrift 暴露 */
  const accountIdsRef = { value: options.accountIds ?? ['123456'] };
  const pool = {
    isActive: () => poolActive.value,
    ids: () => accountIdsRef.value,
    getConfig: () => ({ token: '123456:TOKEN', chatId: '-1' }),
    primaryAccountId: () => (options.primaryAccountId === undefined ? '123456' : options.primaryAccountId),
  };

  const pollDelayMs = options.pollDelayMs ?? 5;
  /** 计数在桩外维护：mock.calls 的入账时机不便在实现内部可靠读取 */
  let pollCallIndex = 0;

  /**
   * 池化客户端桩。
   *
   * 为什么不再「立即抛错」：循环条件修好后，抛错会走 catch 分支并进入指数退避
   * （首次 1000ms），既拖慢既有用例，也让「循环是否真的执行」难以断言。
   * 默认返回空批次可让循环稳定停在 await 上：既能断言调用次数与参数，
   * 也能毫秒级优雅关闭。需要失败路径的用例用 `failPolling` 显式打开。
   */
  const accountGetUpdates = jest.fn(
    async (
      _accountId: string,
      _token: string,
      _offset: number,
      _timeoutSeconds: number,
    ): Promise<unknown[]> => {
      const index = pollCallIndex++;
      if (options.failPolling) throw new Error('测试桩：轮询失败 123456:TOKEN');
      await tick(pollDelayMs);
      return options.updateBatches?.[index] ?? [];
    },
  );
  /** 单账号路径桩（与池化桩同语义，用于反向用例） */
  const singleGetUpdates = jest.fn(
    async (_offset: number, _timeoutSeconds: number): Promise<unknown[]> => {
      if (options.failPolling) throw new Error('测试桩：轮询失败');
      await tick(pollDelayMs);
      return [];
    },
  );

  const accountClient = {
    getUpdates: accountGetUpdates,
    getWebhookInfo: jest.fn(async () => ({ url: '' })),
  };
  const telegramService = {
    getWebhookInfo: jest.fn(async () => ({ url: '' })),
    getUpdates: singleGetUpdates,
  };
  const dispatch = { handleUpdate: jest.fn(async () => undefined) };

  const service = new TelegramBotPollingService(
    telegramService as never,
    dispatch as never,
    configCache as never,
    configService,
    pool as never,
    accountClient as never,
  );
  return {
    service,
    store,
    writes,
    accountGetUpdates,
    singleGetUpdates,
    dispatch,
    poolActive,
    accountIdsRef,
  };
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

/**
 * 池化模式下「循环是否真的在跑」的回归防线。
 *
 * 回归背景（v1.5.3 P0）：池化分支在启动循环后提前 `return`，跳过了单账号路径的
 * `this.running = true`，导致 `accountLoop` 的循环条件 `this.running && state.running`
 * 恒为假——循环体一次都不执行、连异常都不产生，入站消费彻底空转。
 * 上面那批用例只断言 offset 落库，**即使循环空转也会通过**；因此这里必须断言
 * `accountClient.getUpdates` 真的被调用过。
 */
describe('TelegramBotPollingService（池化入站循环真跑）', () => {
  it('池化模式下账号循环真实发起 getUpdates，并带上该账号的 offset', async () => {
    const { service, accountGetUpdates, singleGetUpdates } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_POLL_TIMEOUT_SECONDS: '7' },
      stored: { [BOT_UPDATE_OFFSET_KEY]: '7788' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    // 补一拍：首个 getUpdates 在 onModuleInit 内即被同步调用，但显式等待可避免
    // 未来把 accountLoop 改成先 await 其它操作后出现假阴性
    await tick(5);

    // 修复前为 0 次（循环体从未执行）
    expect(accountGetUpdates.mock.calls.length).toBeGreaterThan(0);
    // 参数顺序与语义：(accountId, token, offset, pollTimeoutSeconds)
    expect(accountGetUpdates.mock.calls[0]).toEqual(['123456', '123456:TOKEN', 7788, 7]);
    // 池化模式不得触碰单账号客户端
    expect(singleGetUpdates).not.toHaveBeenCalled();

    await service.onApplicationShutdown();
  });

  it('池化模式下每个账号各有独立循环，且各自使用自己的 offset', async () => {
    const { service, accountGetUpdates } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_POLL_TIMEOUT_SECONDS: '5' },
      stored: { [BOT_UPDATE_OFFSET_KEY]: '7788' },
      accountIds: ['111', '222'],
      primaryAccountId: '111',
    });

    await service.onModuleInit();

    const polledAccounts = new Set(accountGetUpdates.mock.calls.map((call) => call[0]));
    expect(polledAccounts).toEqual(new Set(['111', '222']));
    // 主 Bot 继承历史全局 offset；非主 Bot 从 0 开始（update_id 序列彼此独立）
    expect(accountGetUpdates.mock.calls.find((call) => call[0] === '111')?.[2]).toBe(7788);
    expect(accountGetUpdates.mock.calls.find((call) => call[0] === '222')?.[2]).toBe(0);

    await service.onApplicationShutdown();
  });

  it('账号池未生效时走单账号轮询，不触碰账号池客户端（防反向回归）', async () => {
    const { service, accountGetUpdates, singleGetUpdates } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_POLL_TIMEOUT_SECONDS: '9' },
      pooled: false,
      stored: { [BOT_UPDATE_OFFSET_KEY]: '42' },
    });

    await service.onModuleInit();

    expect(singleGetUpdates.mock.calls[0]).toEqual([42, 9]);
    expect(accountGetUpdates).not.toHaveBeenCalled();

    await service.onApplicationShutdown();
  });

  it('入站开关关闭时不启动任何轮询', async () => {
    const { service, accountGetUpdates, singleGetUpdates } = makeService({
      env: { TELEGRAM_BOT_POLL_TIMEOUT_SECONDS: '5' },
    });

    await service.onModuleInit();

    expect(accountGetUpdates).not.toHaveBeenCalled();
    expect(singleGetUpdates).not.toHaveBeenCalled();

    await service.onApplicationShutdown();
  });
});

/**
 * 入站可观测性：把「空转」这类无日志、无异常的静默失效变成可见事实。
 */
describe('TelegramBotPollingService（入站可观测性）', () => {
  it('池化模式消费更新：推进 offset、把 accountId 传给分派层并计入快照', async () => {
    const { service, store, dispatch } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_POLL_TIMEOUT_SECONDS: '5' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
      updateBatches: [[{ update_id: 939050190 }]],
    });

    await service.onModuleInit();
    await tick(20);

    expect(dispatch.handleUpdate).toHaveBeenCalledWith(
      { update_id: 939050190 },
      { accountId: '123456' },
    );
    expect(store.get(`${BOT_UPDATE_OFFSET_KEY}:123456`)).toBe('939050191');

    const snapshot = service.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.mode).toBe('pooled');
    expect(snapshot.running).toBe(true);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0].accountId).toBe('123456');
    expect(snapshot.accounts[0].offset).toBe(939050191);
    expect(snapshot.accounts[0].updateCount).toBe(1);
    expect(snapshot.accounts[0].pollCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.accounts[0].lastPollAtMs).not.toBeNull();
    expect(snapshot.lastPollAtMs).not.toBeNull();
    expect(snapshot.modeDrift.restartRequired).toBe(false);

    await service.onApplicationShutdown();
  });

  it('轮询失败时记录连续失败次数与已脱敏的失败摘要（不含 Token）', async () => {
    const { service } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
      failPolling: true,
    });

    await service.onModuleInit();
    await tick(20);

    const account = service.snapshot().accounts[0];
    expect(account.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(account.lastErrorAtMs).not.toBeNull();
    // 桩抛出的错误文案里带字面 Token：摘要必须已替换，绝不原样带出
    expect(account.lastErrorSummary).toContain('[REDACTED]');
    expect(account.lastErrorSummary).not.toContain('123456:TOKEN');
    expect(account.lastPollAtMs).toBeNull();

    await service.onApplicationShutdown();
  });

  it('账号池运行期被关闭时给出「需重启」的模式漂移提示', async () => {
    const { service, poolActive } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    expect(service.snapshot().modeDrift.restartRequired).toBe(false);

    poolActive.value = false;
    const drift = service.snapshot().modeDrift;
    expect(drift.restartRequired).toBe(true);
    expect(drift.reason).toContain('账号池已停用');

    await service.onApplicationShutdown();
  });

  it('池化模式运行期账号集合变化时提示需重启（新增账号不会被消费）', async () => {
    const { service, accountIdsRef } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true' },
      accountIds: ['111'],
      primaryAccountId: '111',
    });

    await service.onModuleInit();
    expect(service.snapshot().modeDrift.restartRequired).toBe(false);

    // 面板新增账号：它的私聊消息不会有人消费
    accountIdsRef.value = ['111', '222'];
    const added = service.snapshot().modeDrift;
    expect(added.restartRequired).toBe(true);
    expect(added.reason).toContain('222');

    // 面板移除账号：它的循环仍在跑
    accountIdsRef.value = [];
    const removed = service.snapshot().modeDrift;
    expect(removed.restartRequired).toBe(true);
    expect(removed.reason).toContain('111');

    await service.onApplicationShutdown();
  });

  it('自检延迟显式设为 0 时不产生自检结论', async () => {
    const { service } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_INBOUND_SELF_CHECK_SECONDS: '0' },
    });

    await service.onModuleInit();
    await tick(30);

    expect(service.snapshot().selfCheck).toBeNull();
    await service.onApplicationShutdown();
  });

  it('自检在正常轮询后给出健康结论', async () => {
    const { service } = makeService({
      env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_INBOUND_SELF_CHECK_SECONDS: '1' },
      accountIds: ['123456'],
      primaryAccountId: '123456',
    });

    await service.onModuleInit();
    // 自检延迟下限为 1s，等待略超即可（不做 20s 级真实等待）
    await new Promise((resolve) => setTimeout(resolve, 1150));

    expect(service.snapshot().selfCheck?.healthy).toBe(true);

    await service.onApplicationShutdown();
  });

  it('自检发现「已启用但零成功轮询」时输出 error 级空转提示', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { service } = makeService({
        env: { TELEGRAM_BOT_UPDATES_ENABLED: 'true', TELEGRAM_BOT_INBOUND_SELF_CHECK_SECONDS: '0' },
        accountIds: ['123456'],
        primaryAccountId: '123456',
        failPolling: true,
      });

      await service.onModuleInit();
      await tick(20);

      // 直接触发自检（定时调度本身已由上一个用例覆盖），避免再等一次真实延迟
      (service as unknown as { runSelfCheck(): void }).runSelfCheck();

      const selfCheck = service.snapshot().selfCheck;
      expect(selfCheck?.healthy).toBe(false);
      expect(selfCheck?.message).toContain('空转');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('空转'));

      await service.onApplicationShutdown();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

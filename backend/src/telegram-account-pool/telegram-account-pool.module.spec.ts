import { TelegramAccountPoolModule } from './telegram-account-pool.module';

/**
 * 模块级后台定时器的装配契约。
 *
 * 回归背景：本模块原先只在 `onModuleInit` 里按 `isActive()` 早退，导致
 * 「env 默认关闭 + 后台热开启」这条**推荐部署路径**下，运行态告警采集与副本记录清理
 * 永远不会启动——表现为告警静默、`telegram_file_copies` 无界增长，且没有任何报错。
 * 与入站轮询那次 P0 同属「共享状态只在其中一条分支初始化」的静默失效。
 */
function makeModule(options: { active: { value: boolean } }) {
  const hooks: Array<() => void> = [];

  const pool = {
    isActive: () => options.active.value,
    ids: () => ['bot1'],
    getConfig: () => ({ id: 'bot1', token: '1111111:AAAA-secret', chatId: '-1001' }),
    registerProbe: jest.fn(),
    registerActiveHook: jest.fn((fn: () => void) => {
      hooks.push(fn);
    }),
  };
  const client = {
    getMe: jest.fn(async () => ({ ok: true })),
    getChat: jest.fn(async () => ({ type: 'channel', title: 'storage' })),
  };
  const copies = { purgeStale: jest.fn(async () => undefined) };
  const alerts = { runOnce: jest.fn(async () => undefined) };
  const attempts = { purgeStale: jest.fn(async () => ({ converged: 0, deleted: 0 })) };

  const moduleRef = new TelegramAccountPoolModule(
    pool as never,
    client as never,
    copies as never,
    alerts as never,
    null,
    attempts as never,
  );
  return { moduleRef, hooks, pool, client, copies, alerts, attempts, active: options.active };
}

/** 捕获 setInterval 注册的回调，避免真实定时器在测试里泄漏 */
function spyIntervals() {
  const callbacks: Array<() => void> = [];
  const spy = jest.spyOn(global, 'setInterval').mockImplementation(
    ((fn: () => void) => {
      callbacks.push(fn);
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
  );
  return { spy, callbacks };
}

/** 让 `void this.xxx()` 这类 fire-and-forget 的微任务落地 */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('TelegramAccountPoolModule（后台定时器装配）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('启动时账号池未生效：不装配任何定时器，但仍注册生效回调', async () => {
    const { spy } = spyIntervals();
    const { moduleRef, pool } = makeModule({ active: { value: false } });

    await moduleRef.onModuleInit();

    expect(spy).not.toHaveBeenCalled();
    // 回调必须注册：热开启只能靠它唤醒（这正是原缺陷的缺口）
    expect(pool.registerActiveHook).toHaveBeenCalledTimes(1);
  });

  it('运行期热开启（未生效 → 生效）时补装告警与清理定时器，并校验账号存储 Chat', async () => {
    const { spy } = spyIntervals();
    const { moduleRef, hooks, client, active } = makeModule({ active: { value: false } });

    await moduleRef.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    // 面板开启账号池 → 服务在下次刷新时广播「变为生效」并调用已注册回调
    active.value = true;
    hooks[0]();
    await flushMicrotasks();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(client.getChat).toHaveBeenCalledTimes(1);
  });

  it('启动即生效：装配两个定时器并做一次账号存储 Chat 校验', async () => {
    const { spy, callbacks } = spyIntervals();
    const { moduleRef, client } = makeModule({ active: { value: true } });

    await moduleRef.onModuleInit();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(callbacks).toHaveLength(2);
    expect(client.getChat).toHaveBeenCalledTimes(1);
  });

  it('两个定时器分别委派到告警采集与副本清理（含扩散轮次清理）', async () => {
    const { callbacks } = spyIntervals();
    const { moduleRef, alerts, copies, attempts } = makeModule({ active: { value: true } });

    await moduleRef.onModuleInit();
    expect(callbacks).toHaveLength(2);

    callbacks[0]();
    callbacks[1]();
    await flushMicrotasks();

    expect(alerts.runOnce).toHaveBeenCalledTimes(1);
    expect(copies.purgeStale).toHaveBeenCalledWith({
      failedBefore: expect.any(Date),
      pendingBefore: expect.any(Date),
      staleReadyBefore: expect.any(Date),
    });
    // 轮次清理与副本清理分开评审：保留窗口不同，必须都跑
    expect(attempts.purgeStale).toHaveBeenCalledWith({
      activeBefore: expect.any(Date),
      terminalBefore: expect.any(Date),
    });
  });

  it('幂等：重复触发生效回调不会重复装配定时器，也不重复校验账号', async () => {
    const { spy } = spyIntervals();
    const { moduleRef, hooks, client } = makeModule({ active: { value: true } });

    await moduleRef.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(client.getChat).toHaveBeenCalledTimes(1);

    // 服务侧的跃迁去重由 service 单测覆盖；这里直接重复调用也要保持幂等
    hooks[0]();
    hooks[0]();
    await flushMicrotasks();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(client.getChat).toHaveBeenCalledTimes(1);
  });

  it('关闭时清理两个定时器', async () => {
    const { spy } = spyIntervals();
    const clearSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
    const { moduleRef } = makeModule({ active: { value: true } });

    await moduleRef.onModuleInit();
    moduleRef.onApplicationShutdown();

    expect(clearSpy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

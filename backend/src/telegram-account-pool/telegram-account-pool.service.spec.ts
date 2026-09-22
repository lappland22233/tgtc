import { ConfigService } from '@nestjs/config';
import { TelegramAccountPoolService } from './telegram-account-pool.service';

function makePool(env: Record<string, string>) {
  const configService = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
  return new TelegramAccountPoolService(configService);
}

const TOKEN_A = '1111111:AAAA-secret-value-aaaaaaaaaaaaaaaa';
const TOKEN_B = '2222222:BBBB-secret-value-bbbbbbbbbbbbbbbb';
const TOKEN_C = '3333333:CCCC-secret-value-cccccccccccccccc';

describe('TelegramAccountPoolService（选号 / 冷却 / 快照）', () => {
  it('未启用时 isActive=false 且给出可诊断的未生效原因，选号一律返回 null', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ token: TOKEN_A, chatId: '-1001' }]),
    });

    expect(pool.isActive()).toBe(false);
    expect(pool.inactiveReason()).toContain('TELEGRAM_ACCOUNT_POOL_ENABLED');
    expect(pool.select()).toBeNull();
  });

  it('启用但未配置任何账号时给出「未解析到账号」原因', () => {
    const pool = makePool({ TELEGRAM_ACCOUNT_POOL_ENABLED: 'true' });
    expect(pool.isActive()).toBe(false);
    expect(pool.inactiveReason()).toContain('未解析到任何账号');
  });

  it('解析 TELEGRAM_ACCOUNT_POOL JSON（含权重/在飞上限）并启用', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([
        { id: 'bot1', token: TOKEN_A, chatId: '-1001', weight: 3, maxInflight: 2 },
        { id: 'bot2', token: TOKEN_B, chatId: '-1002' },
      ]),
    });

    expect(pool.isActive()).toBe(true);
    expect(pool.ids()).toEqual(['bot1', 'bot2']);
    expect(pool.getConfig('bot1')).toMatchObject({ weight: 3, maxInflight: 2, chatId: '-1001' });
    // 默认值：weight=1、maxInflight=8
    expect(pool.getConfig('bot2')).toMatchObject({ weight: 1, maxInflight: 8 });
  });

  it('简化输入只复用 TELEGRAM_CHAT_ID，归档群不得充当存储 Chat', () => {
    // 只配 TELEGRAM_BOT_TOKENS + 归档群：不得把归档群当成账号存储 Chat
    const archiveOnly = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_BOT_TOKENS: `${TOKEN_A},${TOKEN_B}`,
      TELEGRAM_ARCHIVE_CHAT_ID: '-100999',
    });
    expect(archiveOnly.getConfig('bot1')?.chatId).toBe('');
    expect(archiveOnly.getConfig('bot2')?.chatId).toBe('');

    // 显式 TELEGRAM_CHAT_ID 才是存储 Chat（归档群仍不参与）
    const withStorage = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_BOT_TOKENS: TOKEN_A,
      TELEGRAM_CHAT_ID: '-100111',
      TELEGRAM_ARCHIVE_CHAT_ID: '-100999',
    });
    expect(withStorage.getConfig('bot1')?.chatId).toBe('-100111');
  });

  it('note 字段去控制字符并截断（降低诊断快照外泄风险）', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([
        { id: 'bot1', token: TOKEN_A, chatId: '-1', note: `line1\u0007\nline2${'x'.repeat(200)}` },
      ]),
    });

    const note = pool.getConfig('bot1')?.note ?? '';
    expect(note).not.toContain('\u0007');
    expect(note).not.toContain('\n');
    expect(note.length).toBeLessThanOrEqual(120);
  });

  it('加权选号：同等条件下权重高的账号被选中', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([
        { id: 'low', token: TOKEN_A, chatId: '-1', weight: 1 },
        { id: 'high', token: TOKEN_B, chatId: '-2', weight: 10 },
      ]),
    });

    const selection = pool.select();
    expect(selection?.accountId).toBe('high');
  });

  it('平局轮转：完全等价的账号被均匀分流（不会全压到第一个）', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([
        { id: 'bot1', token: TOKEN_A, chatId: '-1' },
        { id: 'bot2', token: TOKEN_B, chatId: '-2' },
        { id: 'bot3', token: TOKEN_C, chatId: '-3' },
      ]),
    });

    const picked = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const selection = pool.select();
      expect(selection).not.toBeNull();
      picked.add(selection!.accountId);
    }
    expect(picked.size).toBe(3);
  });

  it('在飞上限：满载账号不再被选中', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([
        { id: 'only', token: TOKEN_A, chatId: '-1', maxInflight: 1 },
      ]),
    });

    expect(pool.select()?.accountId).toBe('only');
    expect(pool.beginAttempt('only')).toBe(true);
    expect(pool.select()).toBeNull();
    pool.releaseAttempt('only');
    expect(pool.select()?.accountId).toBe('only');
  });

  it('失败分类进入冷却，冷却到期后恢复可选（并尊重 retry_after）', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ id: 'only', token: TOKEN_A, chatId: '-1' }]),
    });

    pool.beginAttempt('only');
    pool.finishAttempt('only', { ok: false, failureKind: 'network', retryAfterSeconds: 5 });

    // network 冷却基数 10s（retry_after 5s 不会缩短基数）→ 冷却期间不可选中
    expect(pool.select(['only'])).toBeNull();
    expect(pool.select(['only'], Date.now() + 5_000)).toBeNull();

    const snapshot = pool.snapshot();
    expect(snapshot.accounts[0].coolingDown).toBe(true);
    expect(snapshot.accounts[0].lastErrorKind).toBe('network');

    // 冷却结束后恢复可选
    expect(pool.select(['only'], Date.now() + 11_000)?.accountId).toBe('only');
  });

  it('限流类冷却显著长于网络类，且连续失败按指数放大', () => {
    const flood = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ id: 'only', token: TOKEN_A, chatId: '-1' }]),
    });
    flood.beginAttempt('only');
    flood.finishAttempt('only', { ok: false, failureKind: 'flood' });
    expect(flood.snapshot().accounts[0].cooldownRemainingMs).toBeGreaterThanOrEqual(59_000);

    // 第二次失败：指数放大到 120s（仍在上限 10 分钟内）
    flood.beginAttempt('only');
    flood.finishAttempt('only', { ok: false, failureKind: 'flood' });
    expect(flood.snapshot().accounts[0].cooldownRemainingMs).toBeGreaterThanOrEqual(119_000);
  });

  it('健康探测只更新延迟/健康与计数，不污染带宽画像', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ id: 'only', token: TOKEN_A, chatId: '-1' }]),
    });

    pool.recordProbe('only', true, 42);
    const snapshot = pool.snapshot();
    expect(snapshot.accounts[0].latencyMs).toBe(42);
    expect(snapshot.accounts[0].bandwidthMbps).toBe(0);

    pool.recordProbe('only', false, undefined, 'network down');
    expect(pool.snapshot().accounts[0].coolingDown).toBe(true);
  });

  it('快照与计数均脱敏：不出现完整 Token，计数可累加读取', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ id: 'bot1', token: TOKEN_A, chatId: '-1' }]),
    });

    pool.bumpCounter('selections', 2);
    pool.bumpCounter('replyFailures');

    const snapshot = pool.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.inactiveReason).toBeNull();
    expect(snapshot.counters.selections).toBe(2);
    expect(snapshot.counters.replyFailures).toBe(1);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(TOKEN_A);
    expect(snapshot.accounts[0].tokenPreview).toMatch(/^1111111:[A-Za-z0-9_-]{1,6}\*\*\*$/);
  });

  it('面板热开启：env 未启用但运行时开关打开后，面板账号必须可被选中（不得静默失效）', async () => {
    // 推荐部署路径是「env 留空作为首次默认值 + 后台热开启」。
    // 回归点：选号兜底若读构造期固化的 env 值，会出现 isActive()=true 但 select() 恒 null
    // ——池化「有账号、永远选不中」，静默回退单账号。
    const pool = makePool({});
    expect(pool.isActive()).toBe(false);

    pool.registerAccountSource(async () => [
      { id: 'panel1', token: TOKEN_A, chatId: '-1001', weight: 1, maxInflight: 4, enabled: true },
    ]);
    await pool.refreshExternalAccounts(true);

    expect(pool.isActive()).toBe(true);
    expect(pool.select()?.accountId).toBe('panel1');
    expect(pool.getConfig('panel1')?.source).toBe('panel');
    expect(pool.snapshot().accounts[0].source).toBe('panel');

    // 关闭运行时开关：只阻止新任务，账号配置保留（不删除、不清空）
    await pool.refreshExternalAccounts(false);
    expect(pool.isActive()).toBe(false);
    expect(pool.select()).toBeNull();
    expect(pool.ids()).toEqual(['panel1']);
  });

  it('重复账号 id 只保留首次出现（避免重复分流）', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([
        { id: 'dup', token: TOKEN_A, chatId: '-1' },
        { id: 'dup', token: TOKEN_B, chatId: '-2' },
      ]),
    });

    expect(pool.ids()).toEqual(['dup']);
    expect(pool.getConfig('dup')?.token).toBe(TOKEN_A);
  });

  it('环境变量主 Bot 始终注册为只读 primary 账号（不影响未启用时的 isActive 语义）', () => {
    const pool = makePool({
      TELEGRAM_BOT_TOKEN: TOKEN_C,
      TELEGRAM_CHAT_ID: '-100777',
    });

    // 注册表可见（后台需要展示主 Bot 的来源/健康/负载），但未开启池化 → 选号仍为 null
    expect(pool.ids()).toEqual(['3333333']);
    expect(pool.getConfig('3333333')).toMatchObject({
      token: TOKEN_C,
      chatId: '-100777',
      source: 'env',
      primary: true,
    });
    expect(pool.primaryAccountId()).toBe('3333333');
    expect(pool.isActive()).toBe(false);
    expect(pool.select()).toBeNull();

    const snapshot = pool.snapshot();
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]).toMatchObject({ primary: true, source: 'env' });
    // 快照必须脱敏：不得出现完整 Token
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN_C);
  });

  it('主 Bot 与显式配置同 Token 时只标记 primary，不重复注册（防双重轮询/计数）', () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ id: 'bot1', token: TOKEN_A, chatId: '-1001' }]),
      TELEGRAM_BOT_TOKEN: TOKEN_A,
      TELEGRAM_CHAT_ID: '-1001',
    });

    expect(pool.ids()).toEqual(['bot1']);
    expect(pool.getConfig('bot1')?.primary).toBe(true);
    expect(pool.snapshot().accounts).toHaveLength(1);
  });

  it('面板账号与环境变量账号同 Token 时被跳过（环境变量优先，不产生第二个逻辑账号）', async () => {
    const pool = makePool({ TELEGRAM_BOT_TOKEN: TOKEN_A, TELEGRAM_CHAT_ID: '-1001' });
    pool.registerAccountSource(async () => [
      { id: 'panel-dup', token: TOKEN_A, chatId: '-1001', weight: 5, maxInflight: 4, enabled: true },
    ]);
    await pool.refreshExternalAccounts(true);

    expect(pool.ids()).toEqual(['1111111']);
    expect(pool.getConfig('panel-dup')).toBeNull();
    expect(pool.isTokenRegistered(TOKEN_A)).toBe(true);
    expect(pool.isEnvTokenRegistered(TOKEN_A)).toBe(true);
  });

  it('面板账号不得覆盖同 id 的环境变量账号（env 优先，Token 不被替换）', async () => {
    const pool = makePool({ TELEGRAM_BOT_TOKEN: TOKEN_A, TELEGRAM_CHAT_ID: '-1001' });
    pool.registerAccountSource(async () => [
      { id: '1111111', token: TOKEN_B, chatId: '-2002', weight: 9, maxInflight: 1, enabled: true },
    ]);
    await pool.refreshExternalAccounts(true);

    expect(pool.getConfig('1111111')).toMatchObject({ token: TOKEN_A, source: 'env', primary: true });
  });

  it('isEnvTokenRegistered 只认环境变量账号：面板账号 Token 不算 env 冲突', async () => {
    const pool = makePool({ TELEGRAM_ACCOUNT_POOL_ENABLED: 'true' });
    pool.registerAccountSource(async () => [
      { id: 'panel1', token: TOKEN_B, chatId: '-2', weight: 1, maxInflight: 4, enabled: true },
    ]);
    await pool.refreshExternalAccounts(true);

    expect(pool.isTokenRegistered(TOKEN_B)).toBe(true);
    expect(pool.isEnvTokenRegistered(TOKEN_B)).toBe(false);
  });
});

/**
 * 生效跃迁广播与「补装」时序。
 *
 * 回归背景：`refreshExternalAccounts()` 内有两处提前 return，原先只在正常路径末尾
 * 补装探针定时器；一旦早退（未注册账号来源 / 面板账号加载抛错），补装与生效广播
 * 都会被跳过——这就是模块级告警与副本清理定时器在热开启部署下永不启动的根因。
 */
describe('TelegramAccountPoolService（生效跃迁与补装）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('未生效 → 生效只广播一次；周期性刷新不重复触发', async () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ token: TOKEN_A, chatId: '-1001' }]),
    });
    pool.registerAccountSource(async () => []);
    const hook = jest.fn();
    pool.registerActiveHook(hook);

    await pool.onModuleInit();
    expect(pool.isActive()).toBe(false);
    expect(hook).not.toHaveBeenCalled();

    // 面板开启开关（env 已配账号 → 立即生效）
    await pool.refreshExternalAccounts(true);
    expect(pool.isActive()).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);

    // 刷新是周期性的：仍处生效态时不得重复广播（否则重活会被高频重复执行）
    await pool.refreshExternalAccounts(true);
    await pool.refreshExternalAccounts(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('未注册面板账号来源时（第一处早退）仍补装探针并广播', async () => {
    const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(
      (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    );
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ token: TOKEN_A, chatId: '-1001' }]),
    });
    const hook = jest.fn();
    pool.registerActiveHook(hook);

    await pool.refreshExternalAccounts(true);

    expect(pool.isActive()).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(intervalSpy).toHaveBeenCalledTimes(1);
  });

  it('面板账号加载抛错时（第二处早退）仍补装探针并广播', async () => {
    const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(
      (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    );
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ token: TOKEN_A, chatId: '-1001' }]),
    });
    pool.registerAccountSource(async () => {
      throw new Error('面板账号加载失败');
    });
    const hook = jest.fn();
    pool.registerActiveHook(hook);

    await pool.refreshExternalAccounts(true);

    expect(pool.isActive()).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(intervalSpy).toHaveBeenCalledTimes(1);
  });

  it('回落为未生效时不广播，再次生效会重新广播', async () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ token: TOKEN_A, chatId: '-1001' }]),
    });
    const hook = jest.fn();
    pool.registerActiveHook(hook);

    await pool.onModuleInit();
    expect(hook).toHaveBeenCalledTimes(1);

    await pool.refreshExternalAccounts(false);
    expect(pool.isActive()).toBe(false);
    expect(hook).toHaveBeenCalledTimes(1);

    await pool.refreshExternalAccounts(true);
    expect(pool.isActive()).toBe(true);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('单个生效回调抛错不影响其它回调，也不中断账号刷新', async () => {
    const pool = makePool({
      TELEGRAM_ACCOUNT_POOL: JSON.stringify([{ token: TOKEN_A, chatId: '-1001' }]),
    });
    const broken = jest.fn(() => {
      throw new Error('hook boom');
    });
    const healthy = jest.fn();
    pool.registerActiveHook(broken);
    pool.registerActiveHook(healthy);

    await expect(pool.refreshExternalAccounts(true)).resolves.toBeUndefined();

    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(pool.isActive()).toBe(true);
  });
});

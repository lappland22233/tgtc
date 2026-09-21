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
});

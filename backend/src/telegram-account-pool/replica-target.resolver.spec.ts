import {
  REPLICA_TARGET_CONFIG_KEY,
  REPLICA_TARGET_DEFAULT,
  ReplicaTargetResolver,
} from './replica-target.resolver';

/** 构造一个账号快照条目（只填本解析器关心的字段） */
function account(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bot1',
    tokenPreview: '1111…',
    chatId: '-1001',
    enabled: true,
    weight: 1,
    maxInflight: 8,
    inflight: 0,
    bandwidthMbps: 0,
    successRate: 1,
    latencyMs: 0,
    coolingDown: false,
    cooldownRemainingMs: 0,
    consecutiveFailures: 0,
    totalRequests: 0,
    failures: 0,
    totalBytes: 0,
    lastErrorKind: null,
    primary: false,
    storageConfigured: true,
    ...overrides,
  };
}

function build(options: {
  accounts?: ReturnType<typeof account>[];
  active?: boolean;
  systemValue?: string | null;
  envValue?: string;
}) {
  const pool = {
    isActive: () => options.active ?? true,
    snapshot: () => ({
      enabled: options.active ?? true,
      inactiveReason: null,
      counters: {} as never,
      accounts: (options.accounts ?? [account()]) as never[],
    }),
  };
  const configCache = {
    get: jest.fn(async (_key: string, fallback: string) =>
      options.systemValue === undefined ? fallback : (options.systemValue ?? fallback)),
  };
  const configService = {
    get: jest.fn((key: string) => (key === REPLICA_TARGET_CONFIG_KEY ? options.envValue : undefined)),
  };
  const resolver = new ReplicaTargetResolver(pool as never, configCache as never, configService as never);
  return { resolver, pool, configCache, configService };
}

describe('ReplicaTargetResolver', () => {
  it('SystemConfig 优先：读取到合法值时不再看环境变量', async () => {
    const { resolver } = build({ systemValue: '3', envValue: '8' });
    const result = await resolver.resolve();
    expect(result.configured).toBe(3);
    expect(result.configuredSource).toBe('system');
  });

  it('SystemConfig 缺失时回退环境变量，再回退默认值 2', async () => {
    const withEnv = build({ systemValue: '', envValue: '4' });
    expect((await withEnv.resolver.resolve()).configured).toBe(4);
    expect((await withEnv.resolver.resolve()).configuredSource).toBe('env');

    const withoutEnv = build({ systemValue: null, envValue: undefined });
    const result = await withoutEnv.resolver.resolve();
    expect(result.configured).toBe(REPLICA_TARGET_DEFAULT);
    expect(result.configuredSource).toBe('default');
  });

  it('非法配置回退来源链，越界值裁剪到 1-8', async () => {
    const invalid = build({ systemValue: 'abc', envValue: '2' });
    expect((await invalid.resolver.resolve()).configured).toBe(2);

    const tooLarge = build({ systemValue: '99' });
    expect((await tooLarge.resolver.resolve()).configured).toBe(8);

    const zero = build({ systemValue: '0' });
    // 0 视为非法（不是「关闭扩散」的合法表达），回退默认值
    expect((await zero.resolver.resolve()).configured).toBe(REPLICA_TARGET_DEFAULT);
  });

  it('effectiveTarget = min(配置值, 可承载账号数)，并给出降级原因', async () => {
    const { resolver } = build({
      systemValue: '4',
      accounts: [account({ id: 'a' }), account({ id: 'b' })],
    });
    const result = await resolver.resolve();
    expect(result.eligibleCount).toBe(2);
    expect(result.effectiveTarget).toBe(2);
    expect(result.degradedReason).toContain('低于配置目标');
  });

  it('资格判定：禁用 / 无存储 Chat / 冷却 / 连续失败均被排除，且原因可读', async () => {
    const { resolver } = build({
      systemValue: '4',
      accounts: [
        account({ id: 'ok' }),
        account({ id: 'disabled', enabled: false }),
        account({ id: 'nochat', storageConfigured: false }),
        account({ id: 'cooling', coolingDown: true, cooldownRemainingMs: 30_000 }),
        account({ id: 'unhealthy', consecutiveFailures: 3 }),
      ],
    });
    const result = await resolver.resolve();
    expect(result.eligibleAccountIds).toEqual(['ok']);
    expect(result.effectiveTarget).toBe(1);

    const byId = new Map(result.eligibility.map((item) => [item.accountId, item]));
    expect(byId.get('disabled')?.reasons.join()).toContain('禁用');
    expect(byId.get('nochat')?.reasons.join()).toContain('存储 Chat');
    expect(byId.get('cooling')?.reasons.join()).toContain('冷却');
    expect(byId.get('unhealthy')?.reasons.join()).toContain('连续失败');
    expect(byId.get('ok')?.eligible).toBe(true);
  });

  it('没有任何可承载账号时目标为 0 并给出明确降级原因', async () => {
    const { resolver } = build({ systemValue: '3', accounts: [account({ storageConfigured: false })] });
    const result = await resolver.resolve();
    expect(result.eligibleCount).toBe(0);
    expect(result.effectiveTarget).toBe(0);
    expect(result.degradedReason).toContain('没有可承载副本的账号');
  });

  it('账号池未生效时不参与扩散：desiredReplicas 返回 undefined', async () => {
    const { resolver } = build({ active: false, systemValue: '3' });
    expect(await resolver.desiredReplicas()).toBeUndefined();
    expect((await resolver.resolve()).degradedReason).toContain('账号池未生效');
  });

  it('账号池生效且存在可承载账号时返回收敛后的目标值', async () => {
    const { resolver } = build({ systemValue: '8', accounts: [account({ id: 'a' }), account({ id: 'b' })] });
    expect(await resolver.desiredReplicas()).toBe(2);
  });
});

import { ConfigService } from '@nestjs/config';
import { TelegramAccountFeatureService } from './telegram-account-feature.service';

const originalEnv = {
  accountPool: process.env.TELEGRAM_ACCOUNT_POOL_ENABLED,
  mirror: process.env.TELEGRAM_MIRROR_ENABLED,
  poolForce: process.env.TELEGRAM_ACCOUNT_POOL_FORCE_DISABLED,
  mirrorForce: process.env.TELEGRAM_MIRROR_FORCE_DISABLED,
};

function restore(): void {
  const mapping: Array<[string, string | undefined]> = [
    ['TELEGRAM_ACCOUNT_POOL_ENABLED', originalEnv.accountPool],
    ['TELEGRAM_MIRROR_ENABLED', originalEnv.mirror],
    ['TELEGRAM_ACCOUNT_POOL_FORCE_DISABLED', originalEnv.poolForce],
    ['TELEGRAM_MIRROR_FORCE_DISABLED', originalEnv.mirrorForce],
  ];
  for (const [key, value] of mapping) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeService(env: Record<string, string>): {
  service: TelegramAccountFeatureService;
  store: Map<string, string>;
} {
  for (const key of [
    'TELEGRAM_ACCOUNT_POOL_ENABLED',
    'TELEGRAM_MIRROR_ENABLED',
    'TELEGRAM_ACCOUNT_POOL_FORCE_DISABLED',
    'TELEGRAM_MIRROR_FORCE_DISABLED',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const store = new Map<string, string>();
  const cache = {
    get: async (key: string, fallback: string) => store.get(key) ?? fallback,
    set: async (key: string, value: string) => { store.set(key, value); },
  };
  return { service: new TelegramAccountFeatureService(cache as never, new ConfigService()), store };
}

describe('TelegramAccountFeatureService（三层开关）', () => {
  afterEach(restore);

  it('未配置时默认关闭，来源为 default', async () => {
    const { service } = makeService({});
    const state = await service.getState();
    expect(state.accountPoolEnabled).toBe(false);
    expect(state.mirrorEnabled).toBe(false);
    expect(state.accountPoolSource).toBe('default');
    expect(state.mirrorSource).toBe('default');
  });

  it('环境变量作为首次默认值，来源为 env', async () => {
    const { service } = makeService({ TELEGRAM_ACCOUNT_POOL_ENABLED: 'true' });
    const state = await service.getState();
    expect(state.accountPoolEnabled).toBe(true);
    expect(state.accountPoolSource).toBe('env');
    expect(state.mirrorEnabled).toBe(false);
  });

  it('运行时配置优先于环境变量，可热更新与回读', async () => {
    const { service, store } = makeService({ TELEGRAM_ACCOUNT_POOL_ENABLED: 'true' });
    await service.setAccountPoolEnabled(false);
    let state = await service.getState();
    expect(state.accountPoolEnabled).toBe(false);
    expect(state.accountPoolSource).toBe('runtime');
    expect(store.get('TELEGRAM_ACCOUNT_POOL_FEATURE_ENABLED')).toBe('false');

    await service.setMirrorEnabled(true);
    state = await service.getState();
    expect(state.mirrorEnabled).toBe(true);
    expect(state.mirrorSource).toBe('runtime');
  });

  it('强制关闭（紧急止血）覆盖运行时配置，且面板无法开启', async () => {
    const { service } = makeService({
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_ACCOUNT_POOL_FORCE_DISABLED: 'true',
    });
    const state = await service.getState();
    expect(state.accountPoolEnabled).toBe(false);
    expect(state.accountPoolSource).toBe('forced_disabled');
    expect(state.accountPoolForceDisabled).toBe(true);

    await expect(service.setAccountPoolEnabled(true)).rejects.toThrow();
  });
});

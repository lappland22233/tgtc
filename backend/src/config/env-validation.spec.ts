import { validateEnv } from './env-validation';

/**
 * 全部用例均使用独立配置对象显式传入 validateEnv，
 * 不合并宿主/CI 环境（修复 DB_HOST 被宿主值掩盖导致的断言失败，见 2026-09 CI Quality gates）。
 * 仅「默认参数」契约用例临时替换 process.env，并在 afterEach 统一恢复。
 */
describe('validateEnv', () => {
  const originalEnv = process.env;
  const valid: NodeJS.ProcessEnv = {
    DB_TYPE: 'postgres',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USERNAME: 'u',
    DB_PASSWORD: 'p',
    DB_DATABASE: 'd',
    JWT_SECRET: '0123456789abcdef0123456789abcdef',
    TELEGRAM_BOT_TOKEN: '123:abc_DEF-1',
    TELEGRAM_CHAT_ID: '1',
    APP_URL: 'http://localhost',
    NODE_ENV: 'test',
  };

  afterEach(() => {
    process.env = originalEnv;
  });

  it('accepts valid defaults and explicit tuning', () => {
    const env: NodeJS.ProcessEnv = {
      ...valid,
      DB_POOL_SIZE: '10',
      DB_CONNECTION_TIMEOUT_MS: '1',
      DB_STATEMENT_TIMEOUT_MS: '10',
      DB_QUERY_TIMEOUT_MS: '11',
      DB_LOCK_TIMEOUT_MS: '2',
      DB_IDLE_TRANSACTION_TIMEOUT_MS: '3',
      CACHE_TTL_MS: '1',
      FILE_CACHE_NO_CACHE_MODE: 'false',
    };
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('aggregates missing and malformed critical configuration', () => {
    const env: NodeJS.ProcessEnv = {
      ...valid,
      DB_HOST: undefined,
      DB_PORT: '70000',
      JWT_SECRET: 'short',
      TELEGRAM_BOT_TOKEN: 'bad',
      NODE_ENV: 'invalid',
      CACHE_TTL_MS: '0',
      FILE_CACHE_NO_CACHE_MODE: 'yes',
    };
    expect(() => validateEnv(env)).toThrow(
      /DB_HOST 未设置[\s\S]*DB_PORT 不是有效[\s\S]*JWT_SECRET 长度不足[\s\S]*TELEGRAM_BOT_TOKEN 格式错误/,
    );
  });

  it('explicit configuration wins over host environment variables', () => {
    // 模拟 CI/宿主环境注入了合法 DB_HOST/DB_TYPE/SMTP_HOST：
    // 显式配置缺失 DB_HOST 时仍必须报缺失，不被宿主值掩盖（回归 2026-09 CI 失败）；
    // 且显式配置未配置 SMTP 时不应触发任何 SMTP 校验错误。
    const injected = { DB_HOST: '127.0.0.1', DB_TYPE: 'postgres', SMTP_HOST: 'smtp.example.com' };
    Object.assign(process.env, injected);
    try {
      const env: NodeJS.ProcessEnv = { ...valid, DB_HOST: undefined };
      let message = '';
      try {
        validateEnv(env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('DB_HOST 未设置');
      expect(message).not.toContain('SMTP_');
      expect(message).not.toContain('DB_TYPE');
    } finally {
      for (const key of Object.keys(injected)) delete process.env[key];
    }
  });

  it('validates database tuning relationships', () => {
    const env: NodeJS.ProcessEnv = {
      ...valid,
      DB_POOL_SIZE: '201',
      DB_CONNECTION_TIMEOUT_MS: '0',
      DB_STATEMENT_TIMEOUT_MS: '10',
      DB_QUERY_TIMEOUT_MS: '5',
      DB_LOCK_TIMEOUT_MS: '20',
    };
    expect(() => validateEnv(env)).toThrow(/DB_POOL_SIZE[\s\S]*DB_QUERY_TIMEOUT_MS[\s\S]*DB_LOCK_TIMEOUT_MS/);
  });

  it('validates complete SMTP configuration', () => {
    const invalid: NodeJS.ProcessEnv = { ...valid, SMTP_HOST: 'smtp', SMTP_PORT: 'bad', SMTP_SECURE: 'yes' };
    expect(() => validateEnv(invalid)).toThrow(
      /SMTP_PORT[\s\S]*SMTP_USER[\s\S]*SMTP_PASSWORD[\s\S]*SMTP_ENCRYPTION_KEY[\s\S]*SMTP_ENCRYPTION_SALT[\s\S]*SMTP_SECURE/,
    );
    const complete: NodeJS.ProcessEnv = {
      ...valid,
      SMTP_HOST: 'smtp',
      SMTP_PORT: '465',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
      SMTP_ENCRYPTION_KEY: 'a'.repeat(32),
      SMTP_ENCRYPTION_SALT: 'b'.repeat(16),
      SMTP_SECURE: 'TRUE',
    };
    expect(() => validateEnv(complete)).not.toThrow();
  });

  it('rejects placeholder or non-hex SMTP encryption key/salt', () => {
    const placeholder: NodeJS.ProcessEnv = {
      ...valid,
      SMTP_HOST: 'smtp',
      SMTP_PORT: '465',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
      SMTP_ENCRYPTION_KEY: 'change-me-64位随机hex字符串',
      SMTP_ENCRYPTION_SALT: 'change-me-32位随机hex字符串',
    };
    expect(() => validateEnv(placeholder)).toThrow(/SMTP_ENCRYPTION_KEY[\s\S]*SMTP_ENCRYPTION_SALT/);
    const nonHex: NodeJS.ProcessEnv = { ...placeholder, SMTP_ENCRYPTION_KEY: 'nothex', SMTP_ENCRYPTION_SALT: 'zzz' };
    expect(() => validateEnv(nonHex)).toThrow(/SMTP_ENCRYPTION_KEY[\s\S]*SMTP_ENCRYPTION_SALT/);
  });

  it('rejects placeholder and weak-entropy JWT secrets', () => {
    const placeholder: NodeJS.ProcessEnv = { ...valid, JWT_SECRET: 'your-super-secret-jwt-key-change-in-production' };
    expect(() => validateEnv(placeholder)).toThrow(/JWT_SECRET 疑似占位值/);
    const weak: NodeJS.ProcessEnv = { ...valid, JWT_SECRET: 'x'.repeat(32) };
    expect(() => validateEnv(weak)).toThrow(/JWT_SECRET 熵过低/);
  });

  it('warns but accepts absent APP_URL', () => {
    const env: NodeJS.ProcessEnv = { ...valid };
    delete env.APP_URL;
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    try {
      expect(() => validateEnv(env)).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads process.env by default when called without arguments', () => {
    // 默认参数契约：无参调用读取当前 process.env（仅此用例替换环境，afterEach 恢复）。
    process.env = { ...valid };
    expect(() => validateEnv()).not.toThrow();
    delete process.env.DB_HOST;
    expect(() => validateEnv()).toThrow(/DB_HOST 未设置/);
  });
});

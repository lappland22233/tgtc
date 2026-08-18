import { validateEnv } from './env-validation';

describe('validateEnv', () => {
  const original = process.env;
  const valid = {
    DB_HOST:'localhost',DB_PORT:'5432',DB_USERNAME:'u',DB_PASSWORD:'p',DB_DATABASE:'d',
    JWT_SECRET:'0123456789abcdef0123456789abcdef',TELEGRAM_BOT_TOKEN:'123:abc_DEF-1',TELEGRAM_CHAT_ID:'1',
    APP_URL:'http://localhost',NODE_ENV:'test',
  };
  beforeEach(() => { process.env = { ...original, ...valid }; });
  afterAll(() => { process.env = original; });

  it('accepts valid defaults and explicit tuning', () => {
    expect(validateEnv).not.toThrow();
    Object.assign(process.env,{DB_POOL_SIZE:'10',DB_CONNECTION_TIMEOUT_MS:'1',DB_STATEMENT_TIMEOUT_MS:'10',DB_QUERY_TIMEOUT_MS:'11',DB_LOCK_TIMEOUT_MS:'2',DB_IDLE_TRANSACTION_TIMEOUT_MS:'3',CACHE_TTL_MS:'1',FILE_CACHE_NO_CACHE_MODE:'false'});
    expect(validateEnv).not.toThrow();
  });

  it('aggregates missing and malformed critical configuration', () => {
    process.env = { ...original, DB_PORT:'70000', JWT_SECRET:'short', TELEGRAM_BOT_TOKEN:'bad', NODE_ENV:'invalid', CACHE_TTL_MS:'0', FILE_CACHE_NO_CACHE_MODE:'yes' };
    expect(validateEnv).toThrow(/DB_HOST 未设置[\s\S]*DB_PORT 不是有效[\s\S]*JWT_SECRET 长度不足[\s\S]*TELEGRAM_BOT_TOKEN 格式错误/);
  });

  it('validates database tuning relationships', () => {
    Object.assign(process.env,{DB_POOL_SIZE:'201',DB_CONNECTION_TIMEOUT_MS:'0',DB_STATEMENT_TIMEOUT_MS:'10',DB_QUERY_TIMEOUT_MS:'5',DB_LOCK_TIMEOUT_MS:'20'});
    expect(validateEnv).toThrow(/DB_POOL_SIZE[\s\S]*DB_QUERY_TIMEOUT_MS[\s\S]*DB_LOCK_TIMEOUT_MS/);
  });

  it('validates complete SMTP configuration', () => {
    Object.assign(process.env,{SMTP_HOST:'smtp',SMTP_PORT:'bad',SMTP_SECURE:'yes'});
    expect(validateEnv).toThrow(/SMTP_PORT[\s\S]*SMTP_USER[\s\S]*SMTP_PASSWORD[\s\S]*SMTP_ENCRYPTION_KEY[\s\S]*SMTP_ENCRYPTION_SALT[\s\S]*SMTP_SECURE/);
    Object.assign(process.env,{SMTP_PORT:'465',SMTP_USER:'u',SMTP_PASSWORD:'p',SMTP_ENCRYPTION_KEY:'a'.repeat(32),SMTP_ENCRYPTION_SALT:'b'.repeat(16),SMTP_SECURE:'TRUE'});
    expect(validateEnv).not.toThrow();
  });

  it('rejects placeholder or non-hex SMTP encryption key/salt', () => {
    Object.assign(process.env,{SMTP_HOST:'smtp',SMTP_PORT:'465',SMTP_USER:'u',SMTP_PASSWORD:'p',SMTP_ENCRYPTION_KEY:'change-me-64位随机hex字符串',SMTP_ENCRYPTION_SALT:'change-me-32位随机hex字符串'});
    expect(validateEnv).toThrow(/SMTP_ENCRYPTION_KEY[\s\S]*SMTP_ENCRYPTION_SALT/);
    Object.assign(process.env,{SMTP_ENCRYPTION_KEY:'nothex',SMTP_ENCRYPTION_SALT:'zzz'});
    expect(validateEnv).toThrow(/SMTP_ENCRYPTION_KEY[\s\S]*SMTP_ENCRYPTION_SALT/);
  });

  it('rejects placeholder and weak-entropy JWT secrets', () => {
    Object.assign(process.env,{JWT_SECRET:'your-super-secret-jwt-key-change-in-production'});
    expect(validateEnv).toThrow(/JWT_SECRET 疑似占位值/);
    Object.assign(process.env,{JWT_SECRET:'x'.repeat(32)});
    expect(validateEnv).toThrow(/JWT_SECRET 熵过低/);
  });

  it('warns but accepts absent APP_URL', () => {
    delete process.env.APP_URL; const warn = jest.spyOn(console,'warn').mockImplementation();
    expect(validateEnv).not.toThrow(); expect(warn).toHaveBeenCalled(); warn.mockRestore();
  });
});

import { evaluateDeploymentPreflight } from './deployment-preflight';

/**
 * 部署形态与传输安全组合预检（2026-09-10 审查修复 H1 短期方案 / L2 / L7）。
 * 全部用例显式传入配置对象，不读取宿主 process.env。
 */
describe('evaluateDeploymentPreflight', () => {
  it('allows development over plain HTTP with default listen host', () => {
    const result = evaluateDeploymentPreflight({ NODE_ENV: 'development' });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('allows production with explicit SECURE_COOKIE=true (direct HTTPS)', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      APP_HOST: '127.0.0.1',
      SECURE_COOKIE: 'true',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('allows production behind a reverse proxy with TRUST_PROXY_HOPS configured', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      APP_HOST: '127.0.0.1',
      TRUST_PROXY_HOPS: '1',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('warns when production sets neither SECURE_COOKIE=true nor TRUST_PROXY_HOPS', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      APP_HOST: '127.0.0.1',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/SECURE_COOKIE=true[\s\S]*TRUST_PROXY_HOPS/);
  });

  it('warns when production listens on all interfaces', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      APP_HOST: '0.0.0.0',
      SECURE_COOKIE: 'true',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/0\.0\.0\.0/);
  });

  it('rejects multi-instance deployment (unsupported in current version)', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      DEPLOYMENT_MODE: 'multi',
    });
    expect(result.errors.join('\n')).toMatch(/不支持多实例部署/);
  });

  it('rejects invalid DEPLOYMENT_MODE values', () => {
    const result = evaluateDeploymentPreflight({ DEPLOYMENT_MODE: 'cluster' });
    expect(result.errors.join('\n')).toMatch(/DEPLOYMENT_MODE 取值非法/);
  });

  it('rejects account pool without explicit streaming preconditions', () => {
    const missingStreaming = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
    });
    expect(missingStreaming.errors.join('\n')).toMatch(/TELEGRAM_FILE_STREAMING_ENABLED 必须显式设为 true/);

    const badBase = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_FILE_STREAMING_ENABLED: 'true',
      TELEGRAM_FILE_STREAM_BASE: 'not-a-url',
    });
    expect(badBase.errors.join('\n')).toMatch(/TELEGRAM_FILE_STREAM_BASE 不是合法的 http\/https URL/);

    // 留空会回落到官方 API（无 /stream/file 端点）→ 必须拒绝启用
    const emptyBase = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_FILE_STREAMING_ENABLED: 'true',
    });
    expect(emptyBase.errors.join('\n')).toMatch(/TELEGRAM_FILE_STREAM_BASE 必须指向自建 Bot API 的流式基址/);
  });

  it('accepts account pool with complete streaming preconditions', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_ACCOUNT_POOL_ENABLED: 'true',
      TELEGRAM_FILE_STREAMING_ENABLED: 'true',
      TELEGRAM_FILE_STREAM_BASE: 'http://127.0.0.1:8081',
    });
    expect(result.errors).toEqual([]);
  });

  it('rejects user relay switch until the MTProto client is integrated', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_USER_RELAY_ENABLED: 'true',
    });
    expect(result.errors.join('\n')).toMatch(/TELEGRAM_USER_RELAY_ENABLED=true 被拒绝/);
  });

  it('accepts explicit single-instance deployment', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      DEPLOYMENT_MODE: 'single',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

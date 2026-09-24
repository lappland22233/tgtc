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

  /**
   * 用户账号中继**不再**在启动期硬拒绝。
   *
   * 为什么只告警：中继可用性取决于运行期事实（是否已授权 user 账号、session 能否解密、
   * 副本可见群的隐私模式设置），纯函数预检读不到；硬拒绝会让「还没在后台完成授权」的
   * 部署无法启动。真实判定在 `UserRelayService`，不可用时返回**标准化可诊断失败**，
   * 由扩散状态机收口为 blocked_* / retryable_failed 并按指数退避重试。
   */
  it('warns (but does not block) when user relay is enabled without an archive chat', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_USER_RELAY_ENABLED: 'true',
    });
    expect(result.errors).toEqual([]);
    const warnings = result.warnings.join('\n');
    expect(warnings).toMatch(/TELEGRAM_USER_RELAY_ENABLED=true/);
    expect(warnings).toMatch(/TELEGRAM_ARCHIVE_CHAT_ID/);
    // 副本认领的硬前提必须显式提示（漏做时表现为「中继成功但副本数不增长」）
    expect(warnings).toMatch(/关闭隐私模式或设为管理员/);
    // 发布前置检查项：开关重启生效 / 用户账号 / 源群可读 / 目标群可写 + 只读探测入口
    expect(warnings).toMatch(/必须重启后端才生效/);
    expect(warnings).toMatch(/对源群可读/);
    expect(warnings).toMatch(/启用镜像规则目标群/);
    expect(warnings).toMatch(/relay-preflight/);
    // 策略 A 已移除：预检文案不得再承诺任何回退路径
    expect(warnings).not.toMatch(/回退策略 A/);
    expect(warnings).not.toMatch(/逐账号二次上传/);
  });

  it('归档群不再充当副本可见群（目标群唯一权威是启用中的镜像规则）', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_USER_RELAY_ENABLED: 'true',
      TELEGRAM_ARCHIVE_CHAT_ID: '-100999',
    });
    const warnings = result.warnings.join('\n');
    expect(warnings).toMatch(/不再配置 TELEGRAM_ARCHIVE_CHAT_ID|relay-preflight/);
    expect(warnings).not.toMatch(/回退策略 A/);
  });

  it('does not warn about the archive chat when user relay is enabled with one configured', () => {
    const result = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_USER_RELAY_ENABLED: 'true',
      TELEGRAM_ARCHIVE_CHAT_ID: '-100999',
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).not.toMatch(/未配置 TELEGRAM_ARCHIVE_CHAT_ID/);
  });

  it('warns when account features are enabled without the credential encryption key', () => {
    const missingKey = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_MIRROR_ENABLED: 'true',
    });
    expect(missingKey.errors).toEqual([]);
    expect(missingKey.warnings.join('\n')).toMatch(/TELEGRAM_ACCOUNT_ENCRYPTION_KEY/);

    const withKey = evaluateDeploymentPreflight({
      NODE_ENV: 'production',
      SECURE_COOKIE: 'true',
      TELEGRAM_MIRROR_ENABLED: 'true',
      TELEGRAM_ACCOUNT_ENCRYPTION_KEY: 'a'.repeat(64),
    });
    expect(withKey.warnings.join('\n')).not.toMatch(/TELEGRAM_ACCOUNT_ENCRYPTION_KEY/);
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

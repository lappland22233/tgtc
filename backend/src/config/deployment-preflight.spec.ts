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

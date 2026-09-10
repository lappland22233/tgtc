/**
 * 部署形态与传输安全启动预检（2026-09-10 审查修复：H1 短期方案 / L2 / L7）。
 *
 * 与 `env-validation.ts` 的分工：
 * - `validateEnv` 负责「配置是否完整、格式是否合法」，缺失/非法即拒绝启动；
 * - 本模块负责「配置组合在运维语义上是否自洽」，例如声明多实例但架构不支持、
 *   生产环境 TLS/Cookie 组合可能让会话 Cookie 失去 Secure 标志。
 *
 * 设计为纯函数（不读全局、不打印、不退出），便于单测覆盖 HTTP/HTTPS/反代/错误配置组合；
 * 由 `main.ts` 负责记录日志并按 `errors` 决定是否阻止启动。
 */

const DEPLOYMENT_MODES = ['single', 'multi'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export interface DeploymentPreflightResult {
  /** 阻断启动的配置错误。 */
  errors: string[];
  /** 不阻断启动但必须高可见度提示的配置风险。 */
  warnings: string[];
}

/** 解析 TRUST_PROXY_HOPS；返回 undefined 表示未配置或非法（非法由 validateEnv 负责报错）。 */
function parseTrustProxyHops(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const hops = Number(raw);
  return Number.isFinite(hops) && hops >= 0 ? hops : undefined;
}

/**
 * 评估部署形态与传输安全组合。
 *
 * 阻断项（errors）：
 * - `DEPLOYMENT_MODE=multi`：当前版本核心链路仍有进程内内存态（分片会话、
 *   缓存单飞、上传任务态、合并信号量、缩略图去重），多实例会直接导致随机失败，
 *   因此在 Redis 外置专项落地前必须拒绝，而不是用文档模糊描述。
 * - `DEPLOYMENT_MODE` 非法取值。
 *
 * 告警项（warnings）：
 * - 生产环境既未显式 `SECURE_COOKIE=true` 也未配置 `TRUST_PROXY_HOPS`：
 *   若反向代理未转发 `X-Forwarded-Proto: https`，会话 Cookie 会缺少 Secure 标志。
 * - 生产环境监听 `0.0.0.0`：应经反向代理暴露，避免 Node 直接监听公网端口。
 */
export function evaluateDeploymentPreflight(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- 部署形态（H1 短期方案：显式拒绝多实例） ----
  const rawMode = (env.DEPLOYMENT_MODE ?? '').trim().toLowerCase();
  if (rawMode !== '' && !(DEPLOYMENT_MODES as readonly string[]).includes(rawMode)) {
    errors.push(
      `DEPLOYMENT_MODE 取值非法: "${env.DEPLOYMENT_MODE}"（应为 single 或 multi）。`,
    );
  } else if (rawMode === 'multi') {
    errors.push(
      'DEPLOYMENT_MODE=multi 被拒绝：当前版本不支持多实例部署。' +
        '分片上传会话、缓存单飞、上传任务态、合并信号量、缩略图构建去重均为进程内内存态，' +
        '多实例会导致分片上传随机失败、冷回源去重失效、任务态丢失。' +
        '必须部署为单后端实例；多实例支持需先完成 Redis 外置专项（见 docs/multi-instance-redis-design.md）。',
    );
  }

  const isProduction = env.NODE_ENV === 'production';
  if (!isProduction) {
    // 开发/测试环境允许 HTTP 明文与本地监听，不做传输安全告警。
    return { errors, warnings };
  }

  // ---- 传输安全与 Cookie Secure 组合（L2） ----
  const secureCookieConfigured = env.SECURE_COOKIE === 'true';
  const hops = parseTrustProxyHops(env.TRUST_PROXY_HOPS);
  if (!secureCookieConfigured && hops === undefined) {
    warnings.push(
      '生产环境既未设置 SECURE_COOKIE=true，也未配置 TRUST_PROXY_HOPS：' +
        '会话 Cookie 仅在反向代理正确转发 X-Forwarded-Proto: https 时才会带 Secure 标志。' +
        '请显式设置 SECURE_COOKIE=true，或设置 TRUST_PROXY_HOPS=<可信代理层数>，避免 HTTPS 下 Cookie 降级。',
    );
  }

  // ---- 监听地址（L7） ----
  const listenHost = (env.APP_HOST ?? '127.0.0.1').trim();
  if (listenHost === '0.0.0.0' || listenHost === '::') {
    warnings.push(
      `生产环境 APP_HOST=${listenHost} 表示监听所有网卡：请确保前置反向代理（Caddy/nginx），` +
        '不要让 Node 直接暴露公网端口；容器/多网卡场景确需如此时请同时配置 TRUST_PROXY_HOPS。',
    );
  }

  return { errors, warnings };
}

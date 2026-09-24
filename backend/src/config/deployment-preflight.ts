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
 * - 账号池启用但缺少流式前置（未显式 `TELEGRAM_FILE_STREAMING_ENABLED=true`，
 *   或 `TELEGRAM_FILE_STREAM_BASE` 非法）：账号池回源依赖实时流端点。
 *
 * 告警项（warnings）：
 * - 生产环境既未显式 `SECURE_COOKIE=true` 也未配置 `TRUST_PROXY_HOPS`：
 *   若反向代理未转发 `X-Forwarded-Proto: https`，会话 Cookie 会缺少 Secure 标志。
 * - 生产环境监听 `0.0.0.0`：应经反向代理暴露，避免 Node 直接监听公网端口。
 * - 账号池/镜像开关已启用但未配置 `TELEGRAM_ACCOUNT_ENCRYPTION_KEY`：
 *   后台新增/轮换账号会被拒绝（不阻断启动，但属可操作性缺口）。
 * - `TELEGRAM_USER_RELAY_ENABLED=true`：用户账号中继是副本扩散的**唯一**链路，
 *   依赖「已授权的 user 账号 + 可读源群 + 可写副本可见群（全部 Bot 关闭隐私模式或为管理员）」，
 *   这些是**运行期**事实，启动期无法判定，因此只提示；运行期由扩散状态机收口为
 *   `blocked_*` / `retryable_failed` 并按指数退避重试，**不存在任何字节二次传输的降级路径**。
 *   发布前可用 `POST /api/admin/telegram-accounts/relay-preflight` 做只读探测。
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

  // ---- Bot 账号池前置条件（P0：不满足即拒绝启用，绝不请求时静默降级） ----
  const poolEnabled = (env.TELEGRAM_ACCOUNT_POOL_ENABLED ?? '').trim().toLowerCase() === 'true';
  if (poolEnabled) {
    // 账号池回源完全依赖自建 Bot API fork 的实时流端点；未显式启用流式时，
    // 「账号池已启用」只是假象——运行期只会不断回退，因此直接拒绝启动。
    const streamingFlag = (env.TELEGRAM_FILE_STREAMING_ENABLED ?? '').trim().toLowerCase();
    if (streamingFlag !== 'true') {
      errors.push(
        'TELEGRAM_ACCOUNT_POOL_ENABLED=true 时 TELEGRAM_FILE_STREAMING_ENABLED 必须显式设为 true：' +
          '账号池回源依赖自建 Bot API 的 /stream/file 实时流端点（Bot API 需以 --enable-file-streaming 启动），' +
          '缺少该端点会在运行期持续回退，属于「启用了但未生效」。',
      );
    }
    // 流式基址必须**非空且有效**：为空时代码会回落到 TELEGRAM_API_BASE（默认官方 api.telegram.org），
    // 而官方 API 不存在 /stream/file 端点，池化回源会持续失败——必须在启动期就拒绝，而不是运行期降级。
    const streamBase = (env.TELEGRAM_FILE_STREAM_BASE ?? '').trim();
    if (!streamBase) {
      errors.push(
        'TELEGRAM_ACCOUNT_POOL_ENABLED=true 时 TELEGRAM_FILE_STREAM_BASE 必须指向自建 Bot API 的流式基址：'
        + '留空会回落到官方 API（无 /stream/file 端点），导致池化回源持续失败。',
      );
    } else {
      let protocol = '';
      try {
        protocol = new URL(streamBase).protocol;
      } catch {
        protocol = '';
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        errors.push(
          `TELEGRAM_FILE_STREAM_BASE 不是合法的 http/https URL: ${streamBase}（账号池启用时该地址必须有效）。`,
        );
      }
    }
  }

  // ---- 用户账号中继（策略 B）：运行期能力校验 + 启动期前置提示 ----
  // 为什么不在这里做「能力校验」并拒绝启动：中继的可用性取决于**运行期事实**
  // （是否已授权 user 账号、账号 session 能否解密、副本可见群权限），纯函数预检读不到这些。
  // 若在此硬拒绝，运维会因为「还没在后台完成授权」而无法启动服务，反而更糟。
  // 真实判定在 UserRelayService：不可用时返回**标准化可诊断失败**，由扩散状态机收口为
  // blocked_* / retryable_failed 并按指数退避重试。
  //
  // 重要：策略 B 是副本扩散的**唯一**链路，不存在任何字节二次传输的降级路径。
  // 因此这里的提示不是「可选优化建议」，而是「不满足就没有副本扩散」的硬前置条件。
  if ((env.TELEGRAM_USER_RELAY_ENABLED ?? '').trim().toLowerCase() === 'true') {
    if (!(env.TELEGRAM_ARCHIVE_CHAT_ID ?? '').trim()) {
      warnings.push(
        'TELEGRAM_USER_RELAY_ENABLED=true 但未配置 TELEGRAM_ARCHIVE_CHAT_ID：'
          + '入站消息的归档转发（审计留痕）会缺少目的地。'
          + '注意归档群**不再**充当副本可见群——中继目标群只取「启用中的镜像规则目标群」，'
          + '未配置启用规则时扩散会直接判定 blocked_target_chat。',
      );
    }
    warnings.push(
      'TELEGRAM_USER_RELAY_ENABLED=true（用户账号中继）：副本扩散只保留这一条链路，'
        + '发布前必须逐项确认——'
        + '(1) 该开关在构造期读取，变更后必须重启后端才生效；'
        + '(2) 已在「账号管理」授权至少一个 user 账号并启用；'
        + '(3) 该账号对源群可读（Bot 私聊来源必须先经源消息准备链路进入可读群）；'
        + '(4) 已配置并启用镜像规则目标群（副本可见群），且该账号对目标群可写；'
        + '(5) 目标群内**每个 Bot 都已关闭隐私模式或设为管理员**'
        + '（Telegram 硬限制：默认隐私模式下 Bot 收不到用户账号发出的普通群消息，副本将无法被认领）。'
        + '不满足时扩散会明确失败并退避重试，副本缺口持续存在，但文件可用性不受影响。'
        + '可用管理接口 POST /api/admin/telegram-accounts/relay-preflight 做只读探测（默认不发送任何消息）。',
    );
  }

  // ---- 账号池后台管理 / 镜像备份的可操作性告警（不阻断启动，任何环境都提示） ----
  // 管理员在后台新增或轮换账号必须能加密凭据；缺根密钥时会出现
  // 「开关已打开，但加不了账号 / 轮换被拒」的可操作性缺口，必须在启动时显式提示。
  const flagTrue = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'true';
  const wantsAccountFeatures = flagTrue(env.TELEGRAM_MIRROR_ENABLED) || flagTrue(env.TELEGRAM_ACCOUNT_POOL_ENABLED);
  if (wantsAccountFeatures && (env.TELEGRAM_ACCOUNT_ENCRYPTION_KEY ?? '').trim() === '') {
    warnings.push(
      '账号池/镜像已启用但未配置 TELEGRAM_ACCOUNT_ENCRYPTION_KEY（32 字节 base64 或 64 位 hex）：' +
        '后台新增与轮换账号会被拒绝（凭据绝不会明文落库）；环境变量引导的单账号链路不受影响。',
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

/**
 * 启动时关键环境变量校验
 *
 * 在 bootstrap 阶段执行，验证失败则抛出 Error 阻止服务启动。
 * 避免因环境变量缺失导致运行时出现难以排查的错误。
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const errors: string[] = [];

  // ---- 数据库连接 ----
  const dbType = (env.DB_TYPE || 'postgres').toLowerCase();
  if (!['postgres', 'sqlite'].includes(dbType)) errors.push('DB_TYPE 必须是 postgres 或 sqlite');
  if (dbType !== 'sqlite' && !env.DB_HOST) errors.push('DB_HOST 未设置');
  if (dbType !== 'sqlite') {
    if (!env.DB_PORT) errors.push('DB_PORT 未设置');
    else if (isNaN(Number(env.DB_PORT)) || Number(env.DB_PORT) < 1 || Number(env.DB_PORT) > 65535) {
      errors.push('DB_PORT 不是有效端口号 (1–65535)');
    }
    if (!env.DB_USERNAME) errors.push('DB_USERNAME 未设置');
    if (!env.DB_PASSWORD) errors.push('DB_PASSWORD 未设置');
  }

  const dbTimeoutDefaults: Record<string, number> = {
    DB_POOL_SIZE: 20,
    DB_CONNECTION_TIMEOUT_MS: 5000,
    DB_STATEMENT_TIMEOUT_MS: 30000,
    DB_QUERY_TIMEOUT_MS: 35000,
    DB_LOCK_TIMEOUT_MS: 3000,
    DB_IDLE_TRANSACTION_TIMEOUT_MS: 30000,
    DB_SQLITE_BUSY_TIMEOUT_MS: 5000,
  };
  const dbValues: Record<string, number> = {};
  for (const [key, fallback] of Object.entries(dbTimeoutDefaults)) {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    dbValues[key] = value;
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push(`${key} 必须为正整数`);
    }
  }
  if (dbValues.DB_POOL_SIZE > 200) errors.push('DB_POOL_SIZE 不得超过 200');
  if (dbValues.DB_QUERY_TIMEOUT_MS < dbValues.DB_STATEMENT_TIMEOUT_MS) {
    errors.push('DB_QUERY_TIMEOUT_MS 不得小于 DB_STATEMENT_TIMEOUT_MS');
  }
  if (dbValues.DB_LOCK_TIMEOUT_MS > dbValues.DB_STATEMENT_TIMEOUT_MS) {
    errors.push('DB_LOCK_TIMEOUT_MS 不得大于 DB_STATEMENT_TIMEOUT_MS');
  }

  // ---- JWT ----
  if (!env.JWT_SECRET) {
    errors.push('JWT_SECRET 未设置');
  } else if (env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET 长度不足，至少需要 32 个字符');
  } else if (isPlaceholderSecret(env.JWT_SECRET)) {
    errors.push('JWT_SECRET 疑似占位值/示例值，禁止上线使用，请生成随机密钥（openssl rand -hex 32）');
  } else if (isWeakEntropy(env.JWT_SECRET)) {
    errors.push('JWT_SECRET 熵过低（如全部相同字符），请使用随机生成的密钥');
  }

  // ---- G1-06：认证相关关键环境变量的格式/白名单校验 ----
  // SECURE_COOKIE：可选，配置时必须为可识别的布尔字符串，避免 'false' 被误判为 true
  if (env.SECURE_COOKIE && !/^(true|false)$/i.test(env.SECURE_COOKIE)) {
    errors.push('SECURE_COOKIE 必须为 true 或 false');
  }
  // TOKEN_EXTRACTION_MODE：白名单校验，非法值会被 jwt.strategy 静默回退到默认，故启动期强制拦截
  if (env.TOKEN_EXTRACTION_MODE && !['both', 'cookie_only'].includes(env.TOKEN_EXTRACTION_MODE)) {
    errors.push('TOKEN_EXTRACTION_MODE 取值非法: ' + env.TOKEN_EXTRACTION_MODE + '（应为 both 或 cookie_only）');
  }
  // JWT_EXPIRES_IN：使用 ms 风格格式（如 7d / 8h / 30m / 3600s 或纯数字秒），拒绝非法值
  if (env.JWT_EXPIRES_IN && !/^\d+(ms|s|m|h|d|w)?$/i.test(env.JWT_EXPIRES_IN)) {
    errors.push('JWT_EXPIRES_IN 格式非法: ' + env.JWT_EXPIRES_IN + '（应为 ms 风格，如 7d / 8h / 30m / 3600s）');
  }
  // CODE_HMAC_SECRET：用于验证码 HMAC，缺失时回退到 JWT_SECRET（见 auth.service）。
  // 显式配置时必须满足长度与熵要求，避免弱密钥被用于离线伪造验证码哈希。
  if (env.CODE_HMAC_SECRET) {
    if (env.CODE_HMAC_SECRET.length < 32) {
      errors.push('CODE_HMAC_SECRET 长度不足，至少需要 32 个字符');
    } else if (isPlaceholderSecret(env.CODE_HMAC_SECRET)) {
      errors.push('CODE_HMAC_SECRET 疑似占位值/示例值，禁止上线使用，请生成随机密钥（openssl rand -hex 32）');
    } else if (isWeakEntropy(env.CODE_HMAC_SECRET)) {
      errors.push('CODE_HMAC_SECRET 熵过低（如全部相同字符），请使用随机生成的密钥');
    }
  }

  // ---- Telegram 文件存储 ----
  if (!env.TELEGRAM_BOT_TOKEN) {
    errors.push('TELEGRAM_BOT_TOKEN 未设置');
  } else if (!/^\d+:[\w-]+$/.test(env.TELEGRAM_BOT_TOKEN)) {
    errors.push('TELEGRAM_BOT_TOKEN 格式错误（应为 <bot_id>:<token>）');
  }
  // TELEGRAM_CHAT_ID 为上传必需项，缺失时上传会在运行期才失败，故列为启动必检
  if (!env.TELEGRAM_CHAT_ID) {
    errors.push('TELEGRAM_CHAT_ID 未设置');
  }

  // ---- Telegram Bot 入站（文件直链） ----
  // 入站消费总开关：不做热更新（安全边界）。仅显式 true 时启用。
  const botUpdatesEnabled = (env.TELEGRAM_BOT_UPDATES_ENABLED || '').trim().toLowerCase() === 'true';
  if (env.TELEGRAM_BOT_UPDATES_ENABLED && !/^(true|false)$/i.test(env.TELEGRAM_BOT_UPDATES_ENABLED.trim())) {
    errors.push('TELEGRAM_BOT_UPDATES_ENABLED 必须为 true 或 false');
  }
  // 初始管理员 TG 用户 ID（逗号分隔）；入站启用时必须有管理员，否则无人可维护白名单
  const adminIds = (env.TELEGRAM_BOT_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (adminIds.some((id) => !/^\d{1,20}$/.test(id))) {
    errors.push('TELEGRAM_BOT_ADMIN_IDS 格式错误（应为逗号分隔的 TG 数字用户 ID）');
  }
  if (botUpdatesEnabled && adminIds.length === 0) {
    errors.push('TELEGRAM_BOT_UPDATES_ENABLED=true 时必须配置 TELEGRAM_BOT_ADMIN_IDS（初始管理员 TG 用户 ID）');
  }
  if (env.TELEGRAM_BOT_DAILY_LIMIT !== undefined && env.TELEGRAM_BOT_DAILY_LIMIT !== '') {
    const limit = Number(env.TELEGRAM_BOT_DAILY_LIMIT);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100000) {
      errors.push('TELEGRAM_BOT_DAILY_LIMIT 必须为 1–100000 的整数');
    }
  }
  if (env.TELEGRAM_BOT_LINK_TTL_HOURS !== undefined && env.TELEGRAM_BOT_LINK_TTL_HOURS !== '') {
    const ttl = Number(env.TELEGRAM_BOT_LINK_TTL_HOURS);
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 720) {
      errors.push('TELEGRAM_BOT_LINK_TTL_HOURS 必须为 1–720 的整数（小时）');
    }
  }
  if (env.TELEGRAM_BOT_QUOTA_TIMEZONE && !isValidTimeZone(env.TELEGRAM_BOT_QUOTA_TIMEZONE)) {
    errors.push(`TELEGRAM_BOT_QUOTA_TIMEZONE 不是合法 IANA 时区: ${env.TELEGRAM_BOT_QUOTA_TIMEZONE}`);
  }
  if (env.TELEGRAM_BOT_LINK_DOMAIN_MODE && !['auto', 'manual'].includes(env.TELEGRAM_BOT_LINK_DOMAIN_MODE.trim())) {
    errors.push('TELEGRAM_BOT_LINK_DOMAIN_MODE 取值非法（应为 auto 或 manual）');
  }
  if (env.TELEGRAM_BOT_LINK_DOMAIN && !isValidSiteOrigin(env.TELEGRAM_BOT_LINK_DOMAIN)) {
    errors.push('TELEGRAM_BOT_LINK_DOMAIN 必须为 http(s)://host[:port] 形式，且不含路径/查询串');
  }
  if (botUpdatesEnabled && !env.TELEGRAM_BOT_ENCRYPTION_KEY) {
    console.warn(
      '[env-validation] TELEGRAM_BOT_ENCRYPTION_KEY 未设置：Bot 直链将以不可回放模式签发，'
      + '/link_query 仅能返回前缀。建议设置 32 字节 base64/hex 根密钥。',
    );
  }
  if (env.TELEGRAM_BOT_ENCRYPTION_KEY && !isValidEncryptionKey(env.TELEGRAM_BOT_ENCRYPTION_KEY)) {
    errors.push('TELEGRAM_BOT_ENCRYPTION_KEY 必须为 32 字节的 base64 或 64 位 hex 字符串');
  }
  if (env.TELEGRAM_BOT_POLL_TIMEOUT_SECONDS !== undefined && env.TELEGRAM_BOT_POLL_TIMEOUT_SECONDS !== '') {
    const poll = Number(env.TELEGRAM_BOT_POLL_TIMEOUT_SECONDS);
    if (!Number.isSafeInteger(poll) || poll < 1 || poll > 120) {
      errors.push('TELEGRAM_BOT_POLL_TIMEOUT_SECONDS 必须为 1–120 的整数');
    }
  }

  // ---- SMTP 邮件（仅当存在 SMTP_HOST 时校验） ----
  if (env.SMTP_HOST) {
    if (!env.SMTP_PORT) errors.push('SMTP_PORT 未设置（SMTP_HOST 已配置）');
    else if (isNaN(Number(env.SMTP_PORT)) || Number(env.SMTP_PORT) < 1 || Number(env.SMTP_PORT) > 65535) {
      errors.push('SMTP_PORT 不是有效端口号');
    }
    if (!env.SMTP_USER) errors.push('SMTP_USER 未设置（SMTP_HOST 已配置）');
    if (!env.SMTP_PASSWORD) errors.push('SMTP_PASSWORD 未设置（SMTP_HOST 已配置）');
    // SMTP 密码以加密形式存储，解密依赖 SMTP_ENCRYPTION_KEY/SALT。
    // 缺失时首次发送邮件才会 500，故在启动期强制校验。
    // KEY/SALT 必须为随机 hex 字符串且不能是 .env.example 中的占位值，防止复制示例直接上线。
    if (!env.SMTP_ENCRYPTION_KEY) {
      errors.push('SMTP_ENCRYPTION_KEY 未设置（SMTP_HOST 已配置，用于解密 SMTP 密码）');
    } else if (isPlaceholderSecret(env.SMTP_ENCRYPTION_KEY) || !isHex(env.SMTP_ENCRYPTION_KEY)) {
      errors.push('SMTP_ENCRYPTION_KEY 必须是随机 hex 字符串（如 openssl rand -hex 32），且不能使用示例占位值');
    }
    if (!env.SMTP_ENCRYPTION_SALT) {
      errors.push('SMTP_ENCRYPTION_SALT 未设置（SMTP_HOST 已配置，用于解密 SMTP 密码）');
    } else if (isPlaceholderSecret(env.SMTP_ENCRYPTION_SALT) || !isHex(env.SMTP_ENCRYPTION_SALT)) {
      errors.push('SMTP_ENCRYPTION_SALT 必须是随机 hex 字符串（如 openssl rand -hex 16），且不能使用示例占位值');
    }
    // SMTP_SECURE 若配置必须为可识别的布尔字符串，避免 'false' 被误判为 true
    if (env.SMTP_SECURE && !/^(true|false)$/i.test(env.SMTP_SECURE)) {
      errors.push('SMTP_SECURE 必须为 true 或 false');
    }
  }

  // ---- 应用地址 ----
  if (!env.APP_URL) {
    // APP_URL 不存在时仅警告（生产环境建议设置）
    console.warn('[env-validation] APP_URL 未设置，分享链接和密码页将使用默认值 http://localhost:3000');
  }

  // ---- 运行环境与缓存（仅在显式配置但格式错误时报错） ----
  if (env.NODE_ENV && !['development', 'test', 'staging', 'production'].includes(env.NODE_ENV)) {
    errors.push(`NODE_ENV 取值非法: ${env.NODE_ENV}（应为 development/test/staging/production）`);
  }
  if (env.CACHE_TTL_MS && (isNaN(Number(env.CACHE_TTL_MS)) || Number(env.CACHE_TTL_MS) <= 0)) {
    errors.push('CACHE_TTL_MS 必须为正数（毫秒）');
  }
  // FILE_CACHE_NO_CACHE_MODE 若配置必须为可识别的布尔字符串，避免误值静默失效
  if (env.FILE_CACHE_NO_CACHE_MODE && !/^(true|false)$/i.test(env.FILE_CACHE_NO_CACHE_MODE)) {
    errors.push('FILE_CACHE_NO_CACHE_MODE 必须为 true 或 false');
  }

  // ---- 日志分片/轮转（仅在显式配置但格式错误时报错，避免误值静默失效） ----
  if (env.LOG_ROTATION_INTERVAL && !['daily', 'hourly'].includes(env.LOG_ROTATION_INTERVAL)) {
    errors.push('LOG_ROTATION_INTERVAL 取值非法: ' + env.LOG_ROTATION_INTERVAL + '（应为 daily 或 hourly）');
  }
  if (env.LOG_RETENTION_DAYS && (!Number.isSafeInteger(Number(env.LOG_RETENTION_DAYS)) || Number(env.LOG_RETENTION_DAYS) <= 0)) {
    errors.push('LOG_RETENTION_DAYS 必须为正整数');
  }
  if (env.LOG_MAX_FILE_SIZE && (!Number.isSafeInteger(Number(env.LOG_MAX_FILE_SIZE)) || Number(env.LOG_MAX_FILE_SIZE) <= 0)) {
    errors.push('LOG_MAX_FILE_SIZE 必须为正整数（字节）');
  }

  if (errors.length > 0) {
    const msg = '[启动失败] 环境变量校验不通过：\n  - ' + errors.join('\n  - ');
    throw new Error(msg);
  }
}

/**
 * 已知占位/示例密钥黑名单（与 .env.example 中的示例值保持一致）。
 * 用户若直接复制示例上线，会使用公开的已知密钥，故启动期强制拦截。
 */
const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'change-me',
  'your-super-secret',
  'your-super-secret-jwt-key-change-in-production',
  'change-me-64位随机hex字符串',
  'change-me-32位随机hex字符串',
  'changeme',
  'secret',
  'password',
]);

/** 判断是否命中已知占位/示例密钥（大小写不敏感、去空格后比较）。 */
function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.has(normalized)) return true;
  // 兜底：包含"占位"常见标记的也视为占位值
  return /(^|[_-])(change-me|your-secret|your-super-secret|example)([_-]|$)/i.test(normalized);
}

/**
 * 低熵检测：用于密钥强度快速判断。
 * 判定规则：全部为同一字符、或长度明显不足。
 * 注意：合法随机 hex 密钥（仅含 0-9a-f）属于"单字符类别"，但长度足够时视为可接受，
 * 故仅对"全同字符"这种极端低熵情况报错，避免误伤 openssl rand -hex 生成的合法密钥。
 */
function isWeakEntropy(value: string): boolean {
  if (value.length < 32) return true;
  const first = value[0];
  return [...value].every((c) => c === first);
}

/** 判断字符串是否为合法 hex（非空、偶数长度、仅含 0-9a-fA-F）。 */
function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

/** 判断是否为合法 IANA 时区名（依赖 ICU 的 Intl 实现）。 */
export function isValidTimeZone(value: string): boolean {
  const tz = value.trim();
  if (!tz) return false;
  try {
    // 非法时区名会抛 RangeError
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断是否为合法站点来源：http(s)://host[:port]，不含路径、查询串、用户信息、片段。
 * 用于直链域名配置/面板写入校验（防止生成钓鱼链接，R11）。
 */
export function isValidSiteOrigin(value: string): boolean {
  const raw = value.trim();
  if (!raw || raw.length > 255) return false;
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  // pathname 必须为空或根路径；query/hash 一律拒绝
  if (url.pathname && url.pathname !== '/' && url.pathname !== '') return false;
  if (url.search || url.hash) return false;
  return true;
}

/** 校验可逆加密根密钥：32 字节 base64 或 64 位 hex。 */
export function isValidEncryptionKey(value: string): boolean {
  const raw = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return true;
  try {
    return Buffer.from(raw, 'base64').length === 32;
  } catch {
    return false;
  }
}

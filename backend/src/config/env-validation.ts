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
  // 账号池模式（多 Bot）下允许只配置账号池、不配单账号 Token/Chat：
  // 池化启用且有账号来源时，单账号项降级为「可选」（未配置时上传/入站走池内账号）。
  const poolEnabled = (env.TELEGRAM_ACCOUNT_POOL_ENABLED || '').trim().toLowerCase() === 'true';
  const poolRaw = (env.TELEGRAM_ACCOUNT_POOL || '').trim();
  const multiTokens = (env.TELEGRAM_BOT_TOKENS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const poolConfigured = poolEnabled && (poolRaw.length > 0 || multiTokens.length > 0);

  if (!poolConfigured) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      errors.push('TELEGRAM_BOT_TOKEN 未设置');
    } else if (!/^\d+:[\w-]+$/.test(env.TELEGRAM_BOT_TOKEN)) {
      errors.push('TELEGRAM_BOT_TOKEN 格式错误（应为 <bot_id>:<token>）');
    }
    // TELEGRAM_CHAT_ID 为上传必需项，缺失时上传会在运行期才失败，故列为启动必检
    if (!env.TELEGRAM_CHAT_ID) {
      errors.push('TELEGRAM_CHAT_ID 未设置');
    }
  }

  // ---- Telegram Bot 账号池（多账号回源）----
  if (env.TELEGRAM_ACCOUNT_POOL_ENABLED
    && !/^(true|false)$/i.test((env.TELEGRAM_ACCOUNT_POOL_ENABLED || '').trim())) {
    errors.push('TELEGRAM_ACCOUNT_POOL_ENABLED 必须为 true 或 false');
  }
  if (poolRaw) {
    try {
      const parsed = JSON.parse(poolRaw) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) {
        errors.push('TELEGRAM_ACCOUNT_POOL 必须是非空 JSON 数组');
      } else {
        parsed.forEach((item, index) => {
          const entry = item as Record<string, unknown>;
          const token = String(entry?.token ?? '').trim();
          if (!/^\d+:[\w-]+$/.test(token)) {
            errors.push(`TELEGRAM_ACCOUNT_POOL[${index}].token 格式错误（应为 <bot_id>:<token>）`);
          }
          if (!String(entry?.chatId ?? entry?.chat_id ?? '').trim()) {
            errors.push(`TELEGRAM_ACCOUNT_POOL[${index}].chatId 未设置（账号池需要每个账号的上传目标 chat）`);
          }
          const maxInflight = Number(entry?.maxInflight);
          if (entry?.maxInflight !== undefined && (!Number.isSafeInteger(maxInflight) || maxInflight < 1)) {
            errors.push(`TELEGRAM_ACCOUNT_POOL[${index}].maxInflight 必须为正整数`);
          }
        });
      }
    } catch {
      errors.push('TELEGRAM_ACCOUNT_POOL 不是合法 JSON');
    }
  }
  multiTokens.forEach((token, index) => {
    if (!/^\d+:[\w-]+$/.test(token)) {
      errors.push(`TELEGRAM_BOT_TOKENS 第 ${index + 1} 项格式错误（应为 <bot_id>:<token>）`);
    }
  });
  // 简化输入（TELEGRAM_BOT_TOKENS）必须显式提供存储 Chat：
  // 归档群（TELEGRAM_ARCHIVE_CHAT_ID）只用于审计转发，不得作为隐式存储目标，
  // 否则副本会被上传进审计群，混淆审计流与存储流。
  if (poolEnabled && multiTokens.length > 0 && !poolRaw && !(env.TELEGRAM_CHAT_ID || '').trim()) {
    errors.push(
      'TELEGRAM_BOT_TOKENS 作为账号池来源时必须设置 TELEGRAM_CHAT_ID（各账号的上传存储 Chat）；'
      + 'TELEGRAM_ARCHIVE_CHAT_ID 仅用于审计转发，不能充当存储目标。',
    );
  }
  if (env.TELEGRAM_ARCHIVE_CHAT_ID && !/^-?\d{5,20}$/.test(env.TELEGRAM_ARCHIVE_CHAT_ID.trim())) {
    errors.push('TELEGRAM_ARCHIVE_CHAT_ID 格式错误（应为数字 chat id，群组通常以 -100 开头）');
  }
  if (env.TELEGRAM_USER_RELAY_ENABLED
    && !/^(true|false)$/i.test((env.TELEGRAM_USER_RELAY_ENABLED || '').trim())) {
    errors.push('TELEGRAM_USER_RELAY_ENABLED 必须为 true 或 false');
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

  // ---- 下载回源超时分层（首字节 / 空闲 / 总时限） ----
  // 背景：历史实现用固定的 30 分钟「总时限」判断卡死，且不随进度刷新，
  // 4GiB 文件在平均速度低于约 2.28MiB/s 时必然被误杀。现拆分为三层，
  // 并按「有持续进度即刷新」判定，总时限默认禁用（0）。
  const cacheFirstByteMs = readNonNegativeTimeoutEnv(env, 'FILE_CACHE_BUILD_FIRST_BYTE_TIMEOUT_MS', 210_000, errors);
  const cacheIdleMs = readNonNegativeTimeoutEnv(env, 'FILE_CACHE_BUILD_IDLE_TIMEOUT_MS', 150_000, errors);
  const cacheTotalMs = readNonNegativeTimeoutEnv(env, 'FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS', 0, errors);
  const telegramStreamSeconds = readPositiveIntEnv(env, 'TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS', 180, errors);
  // 只接受正整数：main.ts 对 0/非法值一律回退默认 180s，接受 0 会与实现语义不一致
  const httpIdleSeconds = readPositiveIntEnv(env, 'HTTP_IDLE_TIMEOUT_SECONDS', 180, errors);

  // 层级关系只告警不阻断：既有部署可能已自定义其中某一项，直接拒绝启动会让升级失败；
  // 但必须高可见度提示，否则外层会先于内层断开，产生无法分类的 502/504。
  const timeoutWarnings: string[] = [];
  if (cacheFirstByteMs > 0 && cacheIdleMs > 0 && cacheFirstByteMs < cacheIdleMs) {
    timeoutWarnings.push(
      `FILE_CACHE_BUILD_FIRST_BYTE_TIMEOUT_MS(${cacheFirstByteMs}) 小于 FILE_CACHE_BUILD_IDLE_TIMEOUT_MS(${cacheIdleMs})，建议首字节不小于空闲超时`,
    );
  }
  if (cacheTotalMs > 0 && cacheFirstByteMs > 0 && cacheTotalMs <= cacheFirstByteMs) {
    timeoutWarnings.push(
      `FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS(${cacheTotalMs}) 不大于首字节超时(${cacheFirstByteMs})，总时限会先于首字节触发`,
    );
  }
  if (cacheFirstByteMs > 0 && cacheFirstByteMs <= telegramStreamSeconds * 1000) {
    timeoutWarnings.push(
      `FILE_CACHE_BUILD_FIRST_BYTE_TIMEOUT_MS(${cacheFirstByteMs}) 不大于 TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS*1000(${telegramStreamSeconds * 1000})，外层 HTTP 会先断开`,
    );
  }
  if (httpIdleSeconds > 0 && cacheIdleMs > 0 && httpIdleSeconds * 1000 <= cacheIdleMs) {
    timeoutWarnings.push(
      `HTTP_IDLE_TIMEOUT_SECONDS*1000(${httpIdleSeconds * 1000}) 不大于缓存空闲超时(${cacheIdleMs})，Node 会先断开 socket，长传输表现为无原因中断`,
    );
  }
  if (timeoutWarnings.length > 0) {
    console.warn(
      '[env-validation] 下载超时层级存在冲突（不阻断启动，但会导致 502/504 无法分类）：\n  - '
      + timeoutWarnings.join('\n  - '),
    );
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
 * 读取非负整数毫秒配置：0 是合法值，表示「禁用该超时」。
 * 非法值记入 errors 并回退默认值（避免把 fixed 总时限写死后无法关闭）。
 */
function readNonNegativeTimeoutEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  errors: string[],
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    errors.push(`${key} 必须为不小于 0 的整数（毫秒，0 表示禁用）`);
    return fallback;
  }
  return value;
}

/** 读取正整数配置；非法值记入 errors 并回退默认值。 */
function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  errors: string[],
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${key} 必须为正整数`);
    return fallback;
  }
  return value;
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

/**
 * 启动时关键环境变量校验
 *
 * 在 bootstrap 阶段执行，验证失败则抛出 Error 阻止服务启动。
 * 避免因环境变量缺失导致运行时出现难以排查的错误。
 */
export function validateEnv(): void {
  const errors: string[] = [];

  // ---- 数据库连接 ----
  if (!process.env.DB_HOST) errors.push('DB_HOST 未设置');
  if (!process.env.DB_PORT) errors.push('DB_PORT 未设置');
  else if (isNaN(Number(process.env.DB_PORT)) || Number(process.env.DB_PORT) < 1 || Number(process.env.DB_PORT) > 65535) {
    errors.push('DB_PORT 不是有效端口号 (1–65535)');
  }
  if (!process.env.DB_USERNAME) errors.push('DB_USERNAME 未设置');
  if (!process.env.DB_PASSWORD) errors.push('DB_PASSWORD 未设置');
  if (!process.env.DB_DATABASE) errors.push('DB_DATABASE 未设置');

  const dbTimeoutDefaults: Record<string, number> = {
    DB_POOL_SIZE: 20,
    DB_CONNECTION_TIMEOUT_MS: 5000,
    DB_STATEMENT_TIMEOUT_MS: 30000,
    DB_QUERY_TIMEOUT_MS: 35000,
    DB_LOCK_TIMEOUT_MS: 3000,
    DB_IDLE_TRANSACTION_TIMEOUT_MS: 30000,
  };
  const dbValues: Record<string, number> = {};
  for (const [key, fallback] of Object.entries(dbTimeoutDefaults)) {
    const raw = process.env[key];
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
  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET 未设置');
  } else if (process.env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET 长度不足，至少需要 32 个字符');
  }

  // ---- Telegram 文件存储 ----
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    errors.push('TELEGRAM_BOT_TOKEN 未设置');
  } else if (!/^\d+:[\w-]+$/.test(process.env.TELEGRAM_BOT_TOKEN)) {
    errors.push('TELEGRAM_BOT_TOKEN 格式错误（应为 <bot_id>:<token>）');
  }
  // TELEGRAM_CHAT_ID 为上传必需项，缺失时上传会在运行期才失败，故列为启动必检
  if (!process.env.TELEGRAM_CHAT_ID) {
    errors.push('TELEGRAM_CHAT_ID 未设置');
  }

  // ---- SMTP 邮件（仅当存在 SMTP_HOST 时校验） ----
  if (process.env.SMTP_HOST) {
    if (!process.env.SMTP_PORT) errors.push('SMTP_PORT 未设置（SMTP_HOST 已配置）');
    else if (isNaN(Number(process.env.SMTP_PORT)) || Number(process.env.SMTP_PORT) < 1 || Number(process.env.SMTP_PORT) > 65535) {
      errors.push('SMTP_PORT 不是有效端口号');
    }
    if (!process.env.SMTP_USER) errors.push('SMTP_USER 未设置（SMTP_HOST 已配置）');
    if (!process.env.SMTP_PASSWORD) errors.push('SMTP_PASSWORD 未设置（SMTP_HOST 已配置）');
    // SMTP 密码以加密形式存储，解密依赖 SMTP_ENCRYPTION_KEY/SALT。
    // 缺失时首次发送邮件才会 500，故在启动期强制校验。
    if (!process.env.SMTP_ENCRYPTION_KEY) {
      errors.push('SMTP_ENCRYPTION_KEY 未设置（SMTP_HOST 已配置，用于解密 SMTP 密码）');
    }
    if (!process.env.SMTP_ENCRYPTION_SALT) {
      errors.push('SMTP_ENCRYPTION_SALT 未设置（SMTP_HOST 已配置，用于解密 SMTP 密码）');
    }
    // SMTP_SECURE 若配置必须为可识别的布尔字符串，避免 'false' 被误判为 true
    if (process.env.SMTP_SECURE && !/^(true|false)$/i.test(process.env.SMTP_SECURE)) {
      errors.push('SMTP_SECURE 必须为 true 或 false');
    }
  }

  // ---- 应用地址 ----
  if (!process.env.APP_URL) {
    // APP_URL 不存在时仅警告（生产环境建议设置）
    console.warn('[env-validation] APP_URL 未设置，分享链接和密码页将使用默认值 http://localhost:3000');
  }

  // ---- 运行环境与缓存（仅在显式配置但格式错误时报错） ----
  if (process.env.NODE_ENV && !['development', 'test', 'staging', 'production'].includes(process.env.NODE_ENV)) {
    errors.push(`NODE_ENV 取值非法: ${process.env.NODE_ENV}（应为 development/test/staging/production）`);
  }
  if (process.env.CACHE_TTL_MS && (isNaN(Number(process.env.CACHE_TTL_MS)) || Number(process.env.CACHE_TTL_MS) <= 0)) {
    errors.push('CACHE_TTL_MS 必须为正数（毫秒）');
  }
  // FILE_CACHE_NO_CACHE_MODE 若配置必须为可识别的布尔字符串，避免误值静默失效
  if (process.env.FILE_CACHE_NO_CACHE_MODE && !/^(true|false)$/i.test(process.env.FILE_CACHE_NO_CACHE_MODE)) {
    errors.push('FILE_CACHE_NO_CACHE_MODE 必须为 true 或 false');
  }

  if (errors.length > 0) {
    const msg = '[启动失败] 环境变量校验不通过：\n  - ' + errors.join('\n  - ');
    throw new Error(msg);
  }
}

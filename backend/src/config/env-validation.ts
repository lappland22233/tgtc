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

  // ---- SMTP 邮件（仅当存在 SMTP_HOST 时校验） ----
  if (process.env.SMTP_HOST) {
    if (!process.env.SMTP_PORT) errors.push('SMTP_PORT 未设置（SMTP_HOST 已配置）');
    else if (isNaN(Number(process.env.SMTP_PORT)) || Number(process.env.SMTP_PORT) < 1 || Number(process.env.SMTP_PORT) > 65535) {
      errors.push('SMTP_PORT 不是有效端口号');
    }
    if (!process.env.SMTP_USER) errors.push('SMTP_USER 未设置（SMTP_HOST 已配置）');
    if (!process.env.SMTP_PASSWORD) errors.push('SMTP_PASSWORD 未设置（SMTP_HOST 已配置）');
  }

  // ---- 应用地址 ----
  if (!process.env.APP_URL) {
    // APP_URL 不存在时仅警告（生产环境建议设置）
    console.warn('[env-validation] APP_URL 未设置，分享链接和密码页将使用默认值 http://localhost:3000');
  }

  if (errors.length > 0) {
    const msg = '[启动失败] 环境变量校验不通过：\n  - ' + errors.join('\n  - ');
    throw new Error(msg);
  }
}

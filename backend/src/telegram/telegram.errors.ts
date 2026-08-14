/**
 * Telegram 文件引用永久失效错误。
 *
 * 仅当 Telegram Bot API 明确返回资源不存在的错误（如 `invalid file_id`、
 * `file not found`、`FILE_ID_INVALID`）时抛出。网络超时、429 限流、5xx、
 * 连接中断等暂时性错误不会转换为本类型，避免把瞬时故障误判为数据损坏。
 *
 * 调用方（下载链路、管理体检）可据此做精确的状态降级：
 * - 下载链路：捕获后条件标记 status='error' 并失效缓存；
 * - 管理体检：计入 invalid 统计并按 apply 模式标记失效。
 */
export class TelegramFileNotFoundError extends Error {
  readonly code = 'TELEGRAM_FILE_NOT_FOUND';

  constructor(message?: string) {
    super(message || 'Telegram 文件不存在或已失效');
    this.name = 'TelegramFileNotFoundError';
  }
}

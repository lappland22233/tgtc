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

/**
 * Telegram 本地路径失效 / 流式 size 不可用型可恢复错误。
 *
 * 仅当 Bot API 流式端点返回 HTTP 502 且描述命中确证的"路径失效"特征
 * （如 "Exact file size is unavailable from Telegram"），或本地绝对路径
 * 在安全打开时发现不存在（ENOENT）时抛出。
 *
 * 与 {@link TelegramFileNotFoundError}（永久不存在）不同，本类型标识的是
 * **可能可恢复** 的路径失效：file_id 仍有效、Telegram 仍持有文件，
 * 只是本地旧路径已失效。调用方（下载链路）可据此执行单次强制回源。
 * 网络超时、429、普通 5xx 不会转换为本类型，避免误判。
 */
export class TelegramStreamPathError extends Error {
  readonly code = 'TELEGRAM_STREAM_PATH_INVALID';

  constructor(message?: string) {
    super(message || 'Telegram 文件本地路径失效或流式 size 不可用');
    this.name = 'TelegramStreamPathError';
  }
}

import { Readable } from 'node:stream';

export class TelegramRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Telegram API 请求受到限流');
  }
}

/** Axios exposes a streaming endpoint's Telegram error body as a Readable. */
export async function readTelegramRetryAfter(response: { data?: unknown; headers?: Record<string, unknown> }): Promise<number> {
  const body = response.data;
  let decoded = body;
  if (body instanceof Readable) {
    const timer = setTimeout(() => body.destroy(), 1_000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 8_192) break;
        chunks.push(buffer);
      }
      if (size <= 8_192) decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      decoded = null;
    } finally {
      clearTimeout(timer);
    }
  }
  const retryAfter = (decoded as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  const values = [Number(retryAfter), Number(response.headers?.['retry-after'])];
  const valid = values.filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483);
  return valid.length ? Math.max(...valid) : 3;
}

/**
 * 可降级重发的载荷维度。
 *
 * 为什么需要细分：`reply_markup` 超长、`message_effect_id` 无效这类 400 只由**附加字段**
 * 引起，正文完全合法。若降级时只换正文格式而保留附件，纯文本兜底会以同一个 400 再失败一次，
 * 消息仍然丢失。因此降级必须能按维度剥离。
 */
export type TelegramDegradableField = 'rich' | 'parse_mode' | 'reply_markup' | 'message_effect';

/**
 * 与载荷格式无关、换任何格式都会失败的拒收原因。
 *
 * 降级重发对它们毫无意义：既浪费一次请求，又可能让调用方误以为"重试过就好了"。
 * 判定按关键词而非白名单，因为这类文案由 Telegram 服务端给出、措辞会变。
 */
const PERMANENT_REJECTION_MARKERS = [
  'bot was blocked',
  'user is deactivated',
  'chat not found',
  'peer_id_invalid',
  'not enough rights',
  'chat_write_forbidden',
  'have no rights',
  'bot is not a member',
  'chat_admin_required',
  'user_is_blocked',
  'kicked',
];

/** 该 400 是否属于「换格式也不会成功」的永久性拒收 */
export function isPermanentRejection(description: string): boolean {
  const lower = description.toLowerCase();
  return PERMANENT_REJECTION_MARKERS.some(marker => lower.includes(marker));
}

/**
 * Telegram 请求被拒绝（HTTP 400 且不属于文件失效/群组缺失等已知语义）。
 *
 * 为什么单独建类型：富文本降级需要判断「能否安全地换个格式重发」。靠匹配 description
 * 文本既脆弱又会漏（如 `Message text is empty`、`Can't parse rich message JSON object`），
 * 漏判就意味着用户一条消息也收不到。400 表示请求未被受理、消息未投递，重发是安全的；
 * 429 与网络错误则可能已投递，绝不能重发。用状态码表达这个区别比匹配文案可靠。
 *
 * `degradableFields` 说明这次拒收**可归因于哪些可选项**。为空表示无法精确归因；
 * 调用方此时仍可继续降级（只换正文格式），但不应反复重试同一档。
 */
export class TelegramRequestRejectedError extends Error {
  readonly code = 'TELEGRAM_REQUEST_REJECTED';
  readonly status = 400;

  constructor(message?: string, readonly degradableFields: TelegramDegradableField[] = []) {
    super(message || 'Telegram API 请求参数错误');
    this.name = 'TelegramRequestRejectedError';
  }
}

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
 * 仅当 Bot API 专用流式端点返回 HTTP 502（包括 size 未知/无法核对、
 * 本地上下文缺失等构建版本差异），或本地绝对路径在安全打开时发现不存在
 * （ENOENT）时抛出。普通 Telegram API 请求的 502 不转换为本类型。
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

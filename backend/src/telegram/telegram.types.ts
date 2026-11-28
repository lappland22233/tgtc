/**
 * Telegram Bot API 入站更新（getUpdates）的最小类型定义。
 * 仅声明本功能实际消费的字段，避免引入过宽的第三方类型。
 */

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string; // 'private' | 'group' | 'supergroup' | 'channel'
  title?: string;
  username?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  document?: TelegramDocument;
  /** 其他媒体类型的存在性标记（用于“请以文件方式发送”提示） */
  photo?: unknown[];
  video?: unknown;
  audio?: unknown;
  voice?: unknown;
  animation?: unknown;
  sticker?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** 内联按钮回调查询（仅声明本项目消费的字段） */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  /** 按钮携带的回调数据（服务端仍需重新鉴权，不可信） */
  data?: string;
  message?: TelegramMessage;
}

/** 发送消息结果（仅取需要的字段） */
export interface TelegramSendMessageResult {
  message_id: number;
  chat: { id: number };
}

/** 富文本消息载体（自建 Bot API 的 rich_message 载荷，blocks 来源） */
export interface TelegramRichMessage {
  blocks: Array<Record<string, unknown> & { type: string }>;
}

/** 链接预览控制（替代已废弃的 disable_web_page_preview） */
export interface TelegramLinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
}

/** 内联键盘按钮 */
export interface TelegramInlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

/** 文本类发送选项（sendMessage / editMessageText / sendRichMessage 共用） */
export interface TelegramTextSendOptions {
  replyToMessageId?: number;
  disableNotification?: boolean;
  deferRateLimit?: boolean;
  /** 经典标注模式；与 richMessage 互斥 */
  parseMode?: 'HTML';
  richMessage?: TelegramRichMessage;
  replyMarkup?: TelegramReplyMarkup;
  linkPreviewOptions?: TelegramLinkPreviewOptions;
  messageEffectId?: string;
}

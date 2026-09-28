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
}

/** 发送消息结果（仅取需要的字段） */
export interface TelegramSendMessageResult {
  message_id: number;
  chat: { id: number };
}

import { Readable } from 'stream';
import { TelegramFileCopy } from '../common/entities/telegram-file-copy.entity';

/** 账号感知回源的结果：流 + 选中账号 + 选择依据（用于访问日志与排障） */
export interface AccountAwareStreamResult {
  stream: Readable;
  info: { file_id: string; file_size: number };
  /** 实际提供本次回源的账号（botId） */
  accountId: string;
  /**
   * 命中的副本记录。
   * 源账号回退路径（`source-account-fallback`）可能没有副本记录，故允许为 null。
   */
  copy: TelegramFileCopy | null;
  /** 可解释的选择依据（带宽/健康/在飞/权重，或 source-account-fallback） */
  selectionReason: string;
}

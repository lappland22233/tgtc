import { Readable } from 'stream';
import { TelegramFileCopy } from '../common/entities/telegram-file-copy.entity';

export type AccountAwareDownloadFailureReason =
  | 'pool_inactive'
  | 'no_ready_copies'
  | 'all_candidates_busy'
  | 'upstream_attempts_failed'
  | 'source_account_unknown'
  | 'source_account_disabled'
  | 'source_cooling_down'
  | 'source_capacity_busy'
  | 'source_stream_failed'
  | 'copy_lookup_failed';

/** 安全可记录的回源失败摘要；不包含 token 或 file_id。 */
export interface AccountAwareDownloadFailure {
  reason: AccountAwareDownloadFailureReason;
  retryAfterMs?: number;
  readyAccountCount?: number;
  attemptedAccountCount?: number;
}

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

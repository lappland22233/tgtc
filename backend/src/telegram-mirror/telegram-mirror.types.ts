import { TelegramMirrorTaskStatus } from '../common/entities/telegram-mirror-task.entity';

/** 镜像任务队列名（在 `jobs/bull-queue.module.ts` 中注册） */
export const MIRROR_QUEUE_NAME = 'telegram-mirror';

/** 任务最大尝试次数（超过即进入 failed，等待人工重试） */
export const MIRROR_MAX_ATTEMPTS = 5;
/** 退避基数与上限（指数退避，避免失败任务高频重试放大上游压力） */
export const MIRROR_RETRY_BASE_MS = 30_000;
export const MIRROR_RETRY_MAX_MS = 30 * 60 * 1000;
/** blocked 任务不自动重试：必须修复配置或重新授权后由管理员手动重试 */

/** 错误分类：决定任务是重试、阻塞还是终止 */
export type MirrorErrorKind = 'retryable' | 'blocked' | 'permanent';

export interface MirrorErrorClassification {
  /** 稳定的错误码（用于告警聚合与后台筛选，不含敏感信息） */
  code: string;
  kind: MirrorErrorKind;
  /** 已脱敏的摘要（写入 lastErrorSummary） */
  summary: string;
  /** 指定下次重试延迟（如 429 的 retry_after），未指定时使用指数退避 */
  retryAfterMs?: number;
}

/**
 * 一次镜像执行的成功结果。
 *
 * 执行模式恒为 `user_copy`（用户账号从主群服务端转发到镜像群）：
 * 不存在「Bot 重新上传」路径，因此没有模式分支，也没有降级字段。
 */
export interface MirrorExecutionResult {
  targetAccountId: string;
  targetChatId: string;
  targetMessageId: string;
  targetTelegramFileId: string;
  fileSize: number;
  mode: 'user_copy';
}

export interface MirrorTaskSummary {
  queued: number;
  running: number;
  succeeded: number;
  retrying: number;
  failed: number;
  blocked: number;
  cancelled: number;
  todaySucceeded: number;
  todayFailed: number;
  todayBlocked: number;
  lastError: { code: string | null; summary: string | null; at: string | null } | null;
}

export interface MirrorTaskListItem {
  id: string;
  ruleId: string;
  ownerType: string;
  ownerId: string;
  sourceVersion: number;
  mode: string;
  status: TelegramMirrorTaskStatus;
  attempts: number;
  sourceAccountId: string | null;
  targetAccountId: string | null;
  targetChatId: string | null;
  targetMessageId: string | null;
  fileName: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 回执落库失败时的可恢复状态（用于幂等重试判定） */
export interface MirrorReceipt {
  targetAccountId: string;
  targetChatId: string;
  targetMessageId: string;
  targetTelegramFileId: string;
}

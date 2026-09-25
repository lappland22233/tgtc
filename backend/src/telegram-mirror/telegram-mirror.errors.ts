import { TelegramAccountError } from '../telegram-account-pool/telegram-account-client.service';
import { TelegramUserClientError } from '../telegram-user/telegram-user-client.service';
import {
  MirrorErrorClassification,
  MirrorErrorKind,
  MIRROR_RETRY_BASE_MS,
  MIRROR_RETRY_MAX_MS,
} from './telegram-mirror.types';

/**
 * 镜像执行阶段的可分类错误。
 *
 * 为什么需要显式分类而不是靠字符串匹配：镜像的失败处理必须**确定性**——
 * 限流要退避重试、权限/源消息失效要阻塞、凭据失效要让管理员重新授权。
 * 分类错了会分别导致「无限重试打爆上游」或「把可恢复错误当成永久失败」。
 */
export class MirrorExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: MirrorErrorKind = 'blocked',
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MirrorExecutionError';
  }
}

/** 该错误是否意味着「账号能力失效，需要管理员介入」（用于标记账号降级） */
export function isAccountCredentialError(error: unknown): boolean {
  if (isUserClientError(error)) {
    return error.kind === 'auth' || error.kind === 'unavailable';
  }
  if (isAccountError(error)) {
    // 不依赖 kind：账号客户端把 401 归到 `other`，只按 kind 判断会漏掉 Token 失效，
    // 导致「账号一直显示 active、任务持续 blocked」而管理员无从下手。
    return /unauthorized|invalid token|401/i.test(error.message);
  }
  return false;
}

/**
 * 结构化识别账号级错误。
 *
 * 为什么不能只用 `instanceof`：同一模块被多份副本加载（monorepo/依赖提升/设备内多次
 * require）时构造函数身份不同，`instanceof` 会静默失效并退化为「未分类错误」，
 * 使 429/权限等关键分类失真。这里先走 `instanceof` 快路径，再按 `name` + 关键字段兜底。
 */
function isAccountError(error: unknown): error is TelegramAccountError {
  if (error instanceof TelegramAccountError) return true;
  return typeof error === 'object' && error !== null
    && (error as { name?: string }).name === 'TelegramAccountError'
    && typeof (error as { kind?: unknown }).kind === 'string';
}

function isUserClientError(error: unknown): error is TelegramUserClientError {
  if (error instanceof TelegramUserClientError) return true;
  return typeof error === 'object' && error !== null
    && (error as { name?: string }).name === 'TelegramUserClientError'
    && typeof (error as { kind?: unknown }).kind === 'string';
}

/**
 * 统一错误分类。
 *
 * 分类规则：
 * - 429 / FLOOD_WAIT：retryable，且**尊重 retry_after**（不盲目重试）；
 * - 超时/网络：retryable（指数退避）；
 * - 权限不足 / 源消息不存在 / 文件永久失效 / 目标群不可写：blocked（需人工修复配置）；
 * - 凭据失效（session/token）：blocked（需重新授权或轮换）；
 * - 未识别：retryable（由最大尝试次数兜底，不会无限重试）。
 */
export function classifyMirrorError(error: unknown): MirrorErrorClassification {
  if (error instanceof MirrorExecutionError) {
    return {
      code: error.code,
      kind: error.kind,
      summary: error.message.slice(0, 500),
      retryAfterMs: error.retryAfterMs,
    };
  }

  if (isAccountError(error)) {
    const summary = error.message.slice(0, 500);
    if (error.kind === 'flood') {
      return {
        code: 'flood_wait',
        kind: 'retryable',
        summary,
        retryAfterMs: error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : undefined,
      };
    }
    if (error.kind === 'timeout' || error.kind === 'network') {
      return { code: `account_${error.kind}`, kind: 'retryable', summary };
    }

    // 关键顺序：**先判权限/凭据/源失效，再判 unavailable**。
    // Bot API 把「无发帖权限」「文件过大」「file_id 失效」等业务错误统一包在 400 里，
    // 而账号客户端会把非 429/401/5xx 的 4xx 归类为 unavailable。若先按 unavailable
    // 处理，会把「需人工修复权限」的失败当成可重试：反复重传字节、最终以 failed 收口，
    // 且权限类专项告警（依赖错误码）永远不会触发。
    if (/not enough rights|chat_write_forbidden|bot was kicked|not a member|forbidden|admin rights|chat not found/i.test(summary)) {
      return { code: 'target_permission_denied', kind: 'blocked', summary };
    }
    if (/unauthorized|invalid token|401/i.test(summary)) {
      return { code: 'account_unauthorized', kind: 'blocked', summary };
    }
    if (/file_id_invalid|invalid file_id|file not found|exact file size is unavailable|file is too big|file too large/i.test(summary)) {
      return { code: 'source_file_unavailable', kind: 'blocked', summary };
    }
    if (error.kind === 'unavailable') {
      return { code: 'account_unavailable', kind: 'retryable', summary };
    }
    return { code: 'account_error', kind: 'retryable', summary };
  }

  if (isUserClientError(error)) {
    const summary = error.message.slice(0, 500);
    if (error.kind === 'flood') {
      return {
        code: 'flood_wait',
        kind: 'retryable',
        summary,
        retryAfterMs: error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : undefined,
      };
    }
    if (error.kind === 'network') return { code: 'user_client_network', kind: 'retryable', summary };
    if (error.kind === 'auth') return { code: 'user_session_invalid', kind: 'blocked', summary };
    if (error.kind === 'permission') return { code: 'user_permission_denied', kind: 'blocked', summary };
    if (error.kind === 'not_found') return { code: 'source_message_missing', kind: 'blocked', summary };
    if (error.kind === 'unverified') {
      // 「副作用可能已经发生、但无法确认结果」**绝不能按可重试处理**：MTProto 的
      // copyMessages/forwardMessages 没有天然幂等保证，重试会在备份群留下重复消息。
      // 收敛为 blocked，等人工核对备份群后再手动重试或清理。
      return { code: 'user_copy_receipt_unresolved', kind: 'blocked', summary };
    }
    if (error.kind === 'unavailable' || error.kind === 'unsupported') {
      return { code: 'user_client_unavailable', kind: 'blocked', summary };
    }
    return { code: 'user_client_error', kind: 'retryable', summary };
  }

  const message = error instanceof Error ? error.message : String(error);
  const summary = message.slice(0, 500);
  if (/FLOOD_WAIT_(\d+)/i.test(summary)) {
    const seconds = Number(/FLOOD_WAIT_(\d+)/i.exec(summary)?.[1] ?? 0);
    return {
      code: 'flood_wait',
      kind: 'retryable',
      summary,
      retryAfterMs: seconds > 0 ? seconds * 1000 : undefined,
    };
  }
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|timeout/i.test(summary)) {
    return { code: 'network_error', kind: 'retryable', summary };
  }
  if (/not enough rights|forbidden|unauthorized|kicked|chat not found/i.test(summary)) {
    return { code: 'permission_denied', kind: 'blocked', summary };
  }
  return { code: 'unclassified_error', kind: 'retryable', summary };
}

/** 指数退避：base × 2^(attempts-1)，上限 MIRROR_RETRY_MAX_MS */
export function backoffMsFor(attempts: number): number {
  const factor = Math.max(1, attempts) - 1;
  return Math.min(MIRROR_RETRY_BASE_MS * 2 ** factor, MIRROR_RETRY_MAX_MS);
}

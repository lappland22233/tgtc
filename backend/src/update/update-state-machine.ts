import { UpdateTaskStatus } from '../common/entities/update-task.entity';

/**
 * 更新任务状态机（纯函数，唯一事实来源）。
 *
 * 正向流：queued → downloading → verifying → prechecking → backing_up
 *        → extracting → migrating → activating → restarting → health_checking → succeeded
 * 失败流：任一阶段失败 → rollback_pending → rolling_back → rolled_back | rollback_failed
 * 取消：仅 queued / downloading 允许（从 backing_up 起进入不可逆区）。
 * 终态：succeeded / rolled_back / rollback_failed / cancelled（幂等，不可再转移）。
 */
export const UPDATE_TERMINAL_STATUSES: ReadonlySet<UpdateTaskStatus> = new Set([
  'succeeded', 'rolled_back', 'rollback_failed', 'cancelled',
]);

export const UPDATE_CANCELLABLE_STATUSES: ReadonlySet<UpdateTaskStatus> = new Set([
  'queued', 'downloading',
]);

const FORWARD_TRANSITIONS: Readonly<Record<UpdateTaskStatus, readonly UpdateTaskStatus[]>> = {
  queued: ['downloading', 'cancelled'],
  downloading: ['verifying', 'cancelled', 'rollback_pending'],
  verifying: ['prechecking', 'rollback_pending'],
  prechecking: ['backing_up', 'rollback_pending'],
  backing_up: ['extracting', 'rollback_pending'],
  extracting: ['migrating', 'rollback_pending'],
  migrating: ['activating', 'rollback_pending'],
  activating: ['restarting', 'rollback_pending'],
  restarting: ['health_checking', 'rollback_pending'],
  health_checking: ['succeeded', 'rollback_pending'],
  rollback_pending: ['rolling_back'],
  rolling_back: ['rolled_back', 'rollback_failed'],
  succeeded: [],
  rolled_back: [],
  rollback_failed: [],
  cancelled: [],
};

export class UpdateStateTransitionError extends Error {
  constructor(readonly from: UpdateTaskStatus, readonly to: UpdateTaskStatus) {
    super(`非法状态转移：${from} → ${to}`);
    this.name = 'UpdateStateTransitionError';
  }
}

export function isTerminalStatus(status: UpdateTaskStatus): boolean {
  return UPDATE_TERMINAL_STATUSES.has(status);
}

export function isCancellableStatus(status: UpdateTaskStatus): boolean {
  return UPDATE_CANCELLABLE_STATUSES.has(status);
}

export function isActiveStatus(status: UpdateTaskStatus): boolean {
  return !isTerminalStatus(status);
}

export function canTransition(from: UpdateTaskStatus, to: UpdateTaskStatus): boolean {
  if (isTerminalStatus(from)) return false;
  if (from === to) return false;
  return FORWARD_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 校验并返回目标状态；非法转移抛出 UpdateStateTransitionError。 */
export function assertTransition(from: UpdateTaskStatus, to: UpdateTaskStatus): UpdateTaskStatus {
  if (!canTransition(from, to)) {
    throw new UpdateStateTransitionError(from, to);
  }
  return to;
}

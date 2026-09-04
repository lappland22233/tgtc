import { UpdateTaskStatus } from '../common/entities/update-task.entity';
import {
  assertTransition,
  canTransition,
  isCancellableStatus,
  isActiveStatus,
  isTerminalStatus,
  UpdateStateTransitionError,
  UPDATE_CANCELLABLE_STATUSES,
  UPDATE_TERMINAL_STATUSES,
} from './update-state-machine';

describe('update-state-machine', () => {
  const FORWARD_PATH: readonly UpdateTaskStatus[] = [
    'queued', 'downloading', 'verifying', 'prechecking', 'backing_up',
    'extracting', 'migrating', 'activating', 'restarting', 'health_checking', 'succeeded',
  ];

  it('正向路径逐级可达', () => {
    for (let i = 0; i < FORWARD_PATH.length - 1; i++) {
      expect(canTransition(FORWARD_PATH[i], FORWARD_PATH[i + 1])).toBe(true);
    }
  });

  it('任一执行阶段失败可进入 rollback_pending，回退流单向收敛', () => {
    const executing = FORWARD_PATH.filter((status) => status !== 'queued' && status !== 'succeeded');
    for (const status of executing) {
      expect(canTransition(status, 'rollback_pending')).toBe(true);
    }
    expect(canTransition('rollback_pending', 'rolling_back')).toBe(true);
    expect(canTransition('rolling_back', 'rolled_back')).toBe(true);
    expect(canTransition('rolling_back', 'rollback_failed')).toBe(true);
    expect(canTransition('rolled_back', 'rolling_back')).toBe(false);
    expect(canTransition('rollback_pending', 'succeeded')).toBe(false);
  });

  it('终态不可再转移（幂等）', () => {
    const terminals: UpdateTaskStatus[] = ['succeeded', 'rolled_back', 'rollback_failed', 'cancelled'];
    for (const terminal of terminals) {
      expect(isTerminalStatus(terminal)).toBe(true);
      expect(isActiveStatus(terminal)).toBe(false);
      for (const target of FORWARD_PATH) {
        expect(canTransition(terminal, target)).toBe(false);
      }
      expect(canTransition(terminal, terminal)).toBe(false);
    }
    expect([...UPDATE_TERMINAL_STATUSES].sort()).toEqual(terminals.sort());
  });

  it('取消边界：仅 queued/downloading 可取消', () => {
    expect([...UPDATE_CANCELLABLE_STATUSES].sort()).toEqual(['downloading', 'queued']);
    for (const cancellable of UPDATE_CANCELLABLE_STATUSES) {
      expect(isCancellableStatus(cancellable)).toBe(true);
      expect(canTransition(cancellable, 'cancelled')).toBe(true);
    }
    const notCancellable = FORWARD_PATH.filter((status) => !UPDATE_CANCELLABLE_STATUSES.has(status));
    for (const status of notCancellable) {
      expect(canTransition(status, 'cancelled')).toBe(false);
    }
  });

  it('禁止跨阶段跳跃', () => {
    expect(canTransition('queued', 'verifying')).toBe(false);
    expect(canTransition('queued', 'succeeded')).toBe(false);
    expect(canTransition('downloading', 'backing_up')).toBe(false);
    expect(canTransition('health_checking', 'downloading')).toBe(false);
  });

  it('assertTransition 返回目标状态；非法转移抛出结构化错误', () => {
    expect(assertTransition('queued', 'downloading')).toBe('downloading');
    expect(() => assertTransition('queued', 'succeeded')).toThrow(UpdateStateTransitionError);
    try {
      assertTransition('activating', 'cancelled');
      fail('应当抛出 UpdateStateTransitionError');
    } catch (error) {
      expect(error).toBeInstanceOf(UpdateStateTransitionError);
      const transitionError = error as UpdateStateTransitionError;
      expect(transitionError.from).toBe('activating');
      expect(transitionError.to).toBe('cancelled');
      expect(transitionError.message).toContain('activating');
    }
  });
});

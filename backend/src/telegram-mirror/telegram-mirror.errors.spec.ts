/**
 * 回归保护：错误分类必须把「副作用可能已发生但无法确认」与「普通的可重试失败」区分开。
 *
 * 事故背景：无源复制在服务端已复制成功、但返回结果里没有目标消息 ID 时抛出的是
 * `kind='other'`，被分类为 retryable，于是每次重试都在备份群真的多一份副本
 * （`MIRROR_MAX_ATTEMPTS=5`）。
 */
import { TelegramUserClientError } from '../telegram-user/telegram-user-client.service';
import { classifyMirrorError } from './telegram-mirror.errors';

describe('classifyMirrorError（无源复制回执未解析）', () => {
  it('unverified → blocked，绝不按可重试处理', () => {
    const result = classifyMirrorError(
      new TelegramUserClientError('复制请求已被服务端接受，但返回结果未包含目标消息 ID', 'unverified'),
    );

    expect(result.code).toBe('user_copy_receipt_unresolved');
    expect(result.kind).toBe('blocked');
  });

  it('对照：未识别的 other 仍是 retryable（不扩大本次收敛范围）', () => {
    const result = classifyMirrorError(new TelegramUserClientError('未知错误', 'other'));

    expect(result.code).toBe('user_client_error');
    expect(result.kind).toBe('retryable');
  });
});

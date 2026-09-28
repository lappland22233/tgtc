/**
 * 回归保护：传给 teleproto 的 `baseLogger` 必须与它的内部 `Logger` 接口**完全一致**。
 *
 * 事故背景：teleproto 把 `baseLogger` 直接赋给内部 `this._log`，并在**构造期**立即调用
 * `.info()`（后续还会用 `warn/error/debug/setLevel`）。上游曾只传 `{ log, warn, error }`，
 * 于是 `new TelegramClient()` 内抛 `TypeError: this._log.info is not a function`；更糟的是
 * 构造发生在 try 之外，异常既不归类也不落日志，原始英文错误直接变成 500 响应体——表现为
 * “界面看得到、日志查不到”。本文件同时守住接口完整性、静默性与构造期异常的可诊断性。
 */
import { TelegramUserClientService } from './telegram-user-client.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const teleproto = require('teleproto');

const LOGGER_METHODS = ['canSend', 'error', 'warn', 'info', 'debug', 'log', 'setLevel'] as const;
const SILENT_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
const API_ID = 123456;
const API_HASH = 'a'.repeat(32);

describe('TelegramUserClientService（baseLogger 接口兼容性）', () => {
  function setup() {
    const service = new TelegramUserClientService({ get: () => undefined } as never);
    const createBaseLogger = (module: unknown) =>
      (service as unknown as { createBaseLogger(m: unknown): Record<string, unknown> })
        .createBaseLogger(module);
    return { service, createBaseLogger };
  }

  function assertSilentLogger(logger: Record<string, unknown>) {
    for (const method of LOGGER_METHODS) {
      expect(typeof logger[method]).toBe('function');
    }
    // 'none' 级别必须让所有级别都不发送，避免 MTProto 内部细节进入后端日志
    for (const level of SILENT_LEVELS) {
      expect((logger.canSend as (l: string) => boolean)(level)).toBe(false);
    }
  }

  it('复用 teleproto 自带 Logger 并压到 none：接口完整且静默', () => {
    const { createBaseLogger } = setup();
    assertSilentLogger(createBaseLogger(teleproto));
  });

  it('模块未导出 Logger 时回退到接口完整的 no-op logger', () => {
    const { createBaseLogger } = setup();
    assertSilentLogger(createBaseLogger({ ...teleproto, Logger: undefined }));
  });

  it('真实构造 TelegramClient 不抛异常（构造期不再触碰缺失的 _log.info）', () => {
    const { createBaseLogger } = setup();
    const modules = [teleproto, { ...teleproto, Logger: undefined }];
    for (const module of modules) {
      const build = () => new teleproto.TelegramClient(
        new teleproto.sessions.StringSession(''),
        API_ID,
        API_HASH,
        { baseLogger: createBaseLogger(module), autoReconnect: false, connectionRetries: 0 },
      );
      expect(build).not.toThrow();
    }
  });

  it('构造期异常归类为 TelegramUserClientError 并写入告警日志', async () => {
    const { service } = setup();
    // 伪造“构造即崩”的模块，模拟上游 Logger 接口漂移
    jest.spyOn(service as unknown as { tryLoad(): unknown }, 'tryLoad').mockReturnValue({
      TelegramClient: class {
        constructor() {
          throw new TypeError('this._log.info is not a function');
        }
      },
      sessions: { StringSession: class { save() { return ''; } } },
      Api: {},
      Logger: teleproto.Logger,
    });
    const warn = jest.spyOn(
      (service as unknown as { logger: { warn(...args: unknown[]): void } }).logger,
      'warn',
    );

    await expect(
      service.sendLoginCode({ apiId: API_ID, apiHash: API_HASH, session: '' }, '+8613800000000'),
    ).rejects.toMatchObject({ name: 'TelegramUserClientError', kind: 'other' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MTProto 客户端构造失败'));
  });
});

/**
 * 回归保护：无源复制必须携带**确定性 `random_id`**，且目标消息 ID 要从 `UpdateMessageID`
 * 解析——而不是依赖 `UpdateNewChannelMessage` 里的消息实体。
 *
 * 事故背景：频道到频道的复制，服务端返回的 `Updates` 常常不含新消息实体，teleproto 的封装
 * 因此返回 `undefined`；上游把「其实已复制成功」判成失败（`kind='other'` → retryable），
 * `MIRROR_MAX_ATTEMPTS=5` 下每次重试都在备份群真的多留一份副本。
 */
describe('TelegramUserClientService（无源复制的幂等键与回执解析）', () => {
  const credentials = { apiId: API_ID, apiHash: API_HASH, session: '' };

  function setupCopy(invoke: jest.Mock) {
    const service = new TelegramUserClientService({ get: () => undefined } as never);
    const client = {
      connect: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
      getEntity: jest.fn(async (entity: unknown) => entity),
      getInputEntity: jest.fn(async (entity: unknown) => entity),
      invoke,
      session: { save: () => '' },
    };
    class FakeTelegramClient {
      constructor() {
        return client as never;
      }
    }
    jest.spyOn(service as unknown as { tryLoad(): unknown }, 'tryLoad').mockReturnValue({
      TelegramClient: FakeTelegramClient,
      sessions: { StringSession: class { save() { return ''; } } },
      Api: teleproto.Api,
      Logger: teleproto.Logger,
      helpers: teleproto.helpers,
    });
    return { service, client, invoke };
  }

  function updates(updateList: unknown[]) {
    return new teleproto.Api.Updates({
      updates: updateList,
      users: [],
      chats: [],
      date: new Date(),
      seq: 0,
    });
  }

  const params = {
    credentials,
    sourceChatId: '-100111',
    sourceMessageId: '5',
    targetChatId: '-100222',
    idempotencyKey: 'task-1:acc-a',
  };

  it('同一幂等键派生出相同 random_id，并以 dropAuthor 转发提交', async () => {
    const seen: string[] = [];
    const invoke = jest.fn(async (request: Record<string, any>) => {
      seen.push(String(request.randomId?.[0]));
      return updates([]);
    });
    const { service, client } = setupCopy(invoke);

    await expect(service.copyMessage(params)).rejects.toMatchObject({ kind: 'unverified' });
    await expect(service.copyMessage(params)).rejects.toMatchObject({ kind: 'unverified' });

    // 重试必须复用同一个服务端幂等键，否则每次重试都是「新消息」
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).not.toBe('undefined');
    const request = invoke.mock.calls[0][0] as Record<string, any>;
    expect(request.dropAuthor).toBe(true);
    expect(request.id).toEqual([5]);
    expect(request.fromPeer).toBe(-100111);
    expect(request.toPeer).toBe(-100222);
    expect(client.disconnect).toHaveBeenCalledTimes(2);
  });

  it('不同幂等键派生出不同 random_id（互不顶替）', async () => {
    const seen: string[] = [];
    const invoke = jest.fn(async (request: Record<string, any>) => {
      seen.push(String(request.randomId?.[0]));
      return updates([]);
    });
    const { service } = setupCopy(invoke);

    await expect(service.copyMessage({ ...params, idempotencyKey: 'task-1:acc-a' }))
      .rejects.toMatchObject({ kind: 'unverified' });
    await expect(service.copyMessage({ ...params, idempotencyKey: 'task-2:acc-a' }))
      .rejects.toMatchObject({ kind: 'unverified' });

    expect(seen[0]).not.toBe(seen[1]);
  });

  it('从 UpdateMessageID 解析目标消息 ID：服务端未下发消息实体也能拿到', async () => {
    const invoke = jest.fn(async (request: Record<string, any>) => updates([
      new teleproto.Api.UpdateMessageID({ id: 9201, randomId: request.randomId[0] }),
    ]));
    const { service } = setupCopy(invoke);

    await expect(service.copyMessage(params)).resolves.toEqual({
      targetChatId: '-100222',
      targetMessageId: '9201',
    });
  });

  it('退回消息实体解析：仅目标会话的新消息实体存在时仍能拿到 ID', async () => {
    const invoke = jest.fn(async () => updates([
      new teleproto.Api.UpdateNewChannelMessage({
        message: new teleproto.Api.Message({
          id: 9300,
          peerId: new teleproto.Api.PeerChannel({ channelId: 100222 }),
          date: new Date(),
          message: '',
        }),
      }),
    ]));
    const { service } = setupCopy(invoke);

    await expect(service.copyMessage(params)).resolves.toEqual({
      targetChatId: '-100222',
      targetMessageId: '9300',
    });
  });

  it('既无 UpdateMessageID 也无消息实体：归类为 unverified，绝不猜测 ID', async () => {
    const invoke = jest.fn(async () => updates([]));
    const { service } = setupCopy(invoke);

    const error = await service.copyMessage(params).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: 'TelegramUserClientError', kind: 'unverified' });
    expect((error as Error).message).toContain('无法确认备份位置');
  });
});

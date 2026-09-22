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

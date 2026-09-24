import { Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { AccountAwareUploadService } from './account-aware-upload.service';
import { TelegramAccountError } from './telegram-account-client.service';

interface StubAccount {
  id: string;
  chatId: string;
  enabled?: boolean;
}

/** 最小账号池桩：只实现上传选号路径真正依赖的契约（确定性选号，便于断言） */
function makePool(accounts: StubAccount[], options: { active?: boolean } = {}) {
  const states = new Map(accounts.map((account) => [account.id, { inflight: 0, cooldownUntilMs: 0 }]));
  const counters: Record<string, number> = {};

  return {
    isActive: () => options.active ?? true,
    inactiveReason: () => null,
    ids: () => accounts.map((account) => account.id),
    storageAccountIds: () => accounts
      .filter((account) => account.enabled !== false && Boolean(account.chatId))
      .map((account) => account.id),
    getConfig: (id: string) => {
      const account = accounts.find((item) => item.id === id);
      if (!account) return null;
      return {
        id,
        token: `${id}:STUB-TOKEN`,
        chatId: account.chatId,
        weight: 1,
        maxInflight: 8,
        enabled: account.enabled !== false,
        source: 'env' as const,
      };
    },
    // 确定性：按候选顺序取第一个可调度账号（真实实现是加权评分，此处只需可预测）
    select: (candidateIds?: string[]) => {
      const ids = (candidateIds ?? accounts.map((account) => account.id)).filter((id) => {
        const state = states.get(id);
        const account = accounts.find((item) => item.id === id);
        if (!state || !account || account.enabled === false) return false;
        return state.inflight < 8 && state.cooldownUntilMs <= Date.now();
      });
      if (ids.length === 0) return null;
      return { accountId: ids[0], score: 1, reason: 'stub' };
    },
    beginAttempt: (id: string) => {
      const state = states.get(id);
      if (!state) return false;
      state.inflight += 1;
      return true;
    },
    finishAttempt: (id: string, sample: { ok: boolean }) => {
      const state = states.get(id);
      if (!state) return;
      state.inflight = Math.max(0, state.inflight - 1);
      if (!sample.ok) state.cooldownUntilMs = Date.now() + 60_000;
    },
    bumpCounter: (key: string, delta = 1) => {
      counters[key] = (counters[key] ?? 0) + delta;
    },
    counters,
    inflightOf: (id: string) => states.get(id)?.inflight ?? 0,
    coolingDown: (id: string) => (states.get(id)?.cooldownUntilMs ?? 0) > Date.now(),
  };
}

function makeService(options: {
  accounts?: StubAccount[];
  active?: boolean;
  send?: jest.Mock;
}) {
  const pool = makePool(options.accounts ?? [{ id: 'a1', chatId: '-1001' }], { active: options.active });
  const send = options.send ?? jest.fn(async () => ({
    fileId: 'FILE-1',
    fileSize: 100,
    chatId: '-1001',
    messageId: '42',
    fileUniqueId: 'UNIQ-1',
    sample: { ok: true, bytes: 100, durationMs: 100 },
  }));
  const client = { sendDocumentStream: send };
  const service = new AccountAwareUploadService(pool as never, client as never);
  return { service, pool, send };
}

/** 造一个可重复消费的流工厂（并记录每次新建，用于验证「换号必须新开流」） */
function streamFactory() {
  const created: Readable[] = [];
  const factory = (): Readable => {
    const stream = Readable.from([Buffer.alloc(10)]);
    created.push(stream);
    return stream;
  };
  return { factory, created };
}

describe('AccountAwareUploadService（上传选号 / 换号 / 回退）', () => {
  it('池未启用：返回 null 交由调用方回退默认链路，且不发起任何上传', async () => {
    const { service, send } = makeService({ active: false });

    const result = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: streamFactory().factory });
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('无「已配置存储 Chat」的候选：返回 null，不产生必败上传', async () => {
    const { service, send } = makeService({ accounts: [{ id: 'a1', chatId: '' }] });

    const result = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: streamFactory().factory });
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('成功：按负载选号上传并返回实际上传账号与消息定位', async () => {
    const { service, pool, send } = makeService({});
    const { factory } = streamFactory();

    const result = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: factory });
    expect(result).toMatchObject({
      fileId: 'FILE-1',
      chatId: '-1001',
      messageId: '42',
      fileUniqueId: 'UNIQ-1',
      accountId: 'a1',
    });
    expect(send).toHaveBeenCalledTimes(1);
    // 上传账号必须在飞额度已释放，且计入选号计数
    expect(pool.inflightOf('a1')).toBe(0);
    expect(pool.counters.selections).toBe(1);
  });

  it('失败换号：限流账号进入冷却并被排除，第二次尝试换到其它账号', async () => {
    const send = jest.fn()
      .mockRejectedValueOnce(new TelegramAccountError('429 Too Many Requests', 'a1', 'flood', 429, 30))
      .mockResolvedValueOnce({
        fileId: 'FILE-2',
        fileSize: 10,
        chatId: '-1002',
        messageId: '43',
        fileUniqueId: null,
        sample: { ok: true, bytes: 10, durationMs: 50 },
      });
    const { service, pool } = makeService({
      accounts: [{ id: 'a1', chatId: '-1001' }, { id: 'a2', chatId: '-1002' }],
      send,
    });
    const { factory, created } = streamFactory();

    const result = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: factory });
    expect(result?.accountId).toBe('a2');
    expect(result?.fileUniqueId).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    // 换号必须新开流（流只能被消费一次）
    expect(created).toHaveLength(2);
    expect(pool.counters.selections).toBe(2);
    expect(pool.counters.failovers).toBe(1);
    expect(pool.coolingDown('a1')).toBe(true);
    expect(pool.inflightOf('a1')).toBe(0);
    expect(pool.inflightOf('a2')).toBe(0);
  });

  it('全部候选失败：返回 null（调用方回退默认链路），尝试次数有硬上限', async () => {
    const send = jest.fn().mockRejectedValue(new TelegramAccountError('boom', 'a1', 'network', 500));
    const { service, pool } = makeService({
      accounts: [
        { id: 'a1', chatId: '-1' },
        { id: 'a2', chatId: '-2' },
        { id: 'a3', chatId: '-3' },
        { id: 'a4', chatId: '-4' },
      ],
      send,
    });

    const result = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: streamFactory().factory });
    expect(result).toBeNull();
    // 首次 + 最多 2 次换号 = 3 次尝试（不得无限重试）
    expect(send).toHaveBeenCalledTimes(3);
    expect(pool.counters.selections).toBe(3);
    expect(pool.counters.failovers).toBe(2);
  });

  it('未配置存储 Chat 的账号不会被选为上传目标', async () => {
    const { service, send } = makeService({
      accounts: [{ id: 'no-chat', chatId: '' }, { id: 'with-chat', chatId: '-9' }],
    });

    const result = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: streamFactory().factory });
    expect(result?.accountId).toBe('with-chat');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('with-chat');
  });

  it('候选存在但全部不可调度（冷却/满载/禁用）：返回 null 不抛出、记录限频 warn、不发起上传', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    try {
      const { service, pool, send } = makeService({});
      // 唯一候选进入冷却（持续不可调度）→ select 无可用候选 → 回退单账号链路
      pool.finishAttempt('a1', { ok: false });

      const first = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: streamFactory().factory });
      const second = await service.upload({ filename: 'a.bin', knownLength: 10, openStream: streamFactory().factory });

      // 不抛出：调用方据此回退默认单账号链路
      expect(first).toBeNull();
      expect(second).toBeNull();
      expect(send).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith('池化上传选号无可用候选（冷却/满载/禁用），回退单账号链路');
      // 60s 限频：账号持续冷却时第二次上传不再重复 warn，避免刷屏
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('无可用候选'));
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});

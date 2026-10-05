/**
 * 下载期懒触发补扩散的边界回归。
 *
 * 为什么这些用例必须存在：
 * - 下载是高频路径，懒触发一旦「每次都查库 / 每次都建单」就会把下载链路拖慢，
 *   或在镜像群产生重复消息的观感（实际由唯一键兜底，但重复查询仍不可接受）；
 * - 补建必须与历史补偿同口径：**源锚点不可定位时不建单**（否则任务必然 blocked），
 *   且绝不允许跨账号借用 `file_id`（只能用同归属副本锚点兜底的事实）；
 * - 关闭态、池未生效态必须零行为，且关掉再打开后要能立刻恢复（不能在关闭时打冷却）；
 * - fail-open：任何异常都不得冒泡到下载调用方。
 */
import 'reflect-metadata';
import { TelegramMirrorLazyTriggerService, LAZY_TRIGGER_COOLDOWN_MS, LAZY_TRIGGER_MAX_ENTRIES } from './telegram-mirror-lazy-trigger.service';

/** 让 fire-and-forget 的微任务链跑完（真实定时器，避免 fake timers 与 Date.now 间谍互相干扰） */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const DESCRIPTOR = {
  fileId: 'tg-file-id',
  fileSize: 1024,
  fileName: 'a.bin',
  chatId: '-100777',
  messageId: '55',
  sourceAccountId: '777',
  sourceVersion: 2,
};

interface SetupOptions {
  mirrorEnabled?: boolean;
  target?: number | undefined;
  readyAccountIds?: string[];
  descriptor?: Record<string, unknown>;
  created?: boolean;
  describeError?: Error;
  copiesError?: Error;
}

function setup(options: SetupOptions = {}) {
  const feature = { isMirrorEnabled: jest.fn(async () => options.mirrorEnabled ?? true) };
  const trigger = { onFileCommitted: jest.fn(async () => options.created ?? true) };
  const source = {
    describe: jest.fn(async () => {
      if (options.describeError) throw options.describeError;
      return options.descriptor ?? { ...DESCRIPTOR };
    }),
  };
  const copies = {
    readyAccountIds: jest.fn(async () => {
      if (options.copiesError) throw options.copiesError;
      return options.readyAccountIds ?? ['bot-a'];
    }),
  };
  const replicaTargets = {
    desiredReplicas: jest.fn(async () => ('target' in options ? options.target : 2)),
  };

  const service = new TelegramMirrorLazyTriggerService(
    feature as never,
    trigger as never,
    source as never,
    copies as never,
    replicaTargets as never,
  );
  return { service, feature, trigger, source, copies, replicaTargets };
}

describe('TelegramMirrorLazyTriggerService（下载期懒触发补扩散）', () => {
  let now = 1_700_000_000_000;

  beforeEach(() => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('副本不足 → 按源事实建单一次（web_upload 语义、只建单不搬字节）', async () => {
    const ctx = setup({ readyAccountIds: ['bot-a'], target: 2 });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledTimes(1);
    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledWith(
      {
        ownerType: 'file',
        ownerId: 'f-1',
        sourceVersion: 2,
        sourceAccountId: '777',
        sourceChatId: '-100777',
        sourceMessageId: '55',
      },
      'web_upload',
    );
  });

  it('副本达标 → 不查源、不建单', async () => {
    const ctx = setup({ readyAccountIds: ['bot-a', 'bot-b'], target: 2 });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.source.describe).not.toHaveBeenCalled();
    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
  });

  it('同一文件在冷却窗口内重复下载只检查一次，窗口结束后可再次补触发', async () => {
    const ctx = setup({ readyAccountIds: ['bot-a'], target: 2 });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();
    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.copies.readyAccountIds).toHaveBeenCalledTimes(1);
    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledTimes(1);

    now += LAZY_TRIGGER_COOLDOWN_MS + 1;
    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.copies.readyAccountIds).toHaveBeenCalledTimes(2);
    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledTimes(2);
  });

  it('并发下载同一文件：同步占位收敛为一次检查，检查结束即释放', async () => {
    const ctx = setup({ readyAccountIds: ['bot-a'], target: 2 });

    ctx.service.maybeTrigger('file', 'f-1');
    ctx.service.maybeTrigger('file', 'f-1');
    ctx.service.maybeTrigger('file', 'f-1');
    expect(ctx.service.pendingSize()).toBe(1);

    await flush();

    expect(ctx.copies.readyAccountIds).toHaveBeenCalledTimes(1);
    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledTimes(1);
    expect(ctx.service.pendingSize()).toBe(0);
  });

  it('镜像总开关关闭 → 零行为，且不打冷却（重新开启后立刻恢复）', async () => {
    const ctx = setup({ mirrorEnabled: false });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.replicaTargets.desiredReplicas).not.toHaveBeenCalled();
    expect(ctx.copies.readyAccountIds).not.toHaveBeenCalled();
    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
    expect(ctx.service.cooldownSize()).toBe(0);
    expect(ctx.service.pendingSize()).toBe(0);

    ctx.feature.isMirrorEnabled.mockResolvedValue(true);
    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledTimes(1);
  });

  it('账号池未生效（无有效目标）→ 零行为、不打冷却', async () => {
    const ctx = setup({ target: undefined });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.copies.readyAccountIds).not.toHaveBeenCalled();
    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
    expect(ctx.service.cooldownSize()).toBe(0);
  });

  it('源锚点单侧缺失（只有 chatId）同样不建单', async () => {
    const ctx = setup({
      readyAccountIds: [],
      target: 2,
      descriptor: { ...DESCRIPTOR, messageId: null },
    });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
  });

  it('feature.isMirrorEnabled 抛错 → fail-open（不冒泡、不留占位）', async () => {
    const ctx = setup();
    ctx.feature.isMirrorEnabled.mockRejectedValue(new Error('config cache down'));

    expect(() => ctx.service.maybeTrigger('file', 'f-1')).not.toThrow();
    await flush();

    expect(ctx.copies.readyAccountIds).not.toHaveBeenCalled();
    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
    expect(ctx.service.pendingSize()).toBe(0);
  });

  it('desiredReplicas 抛错 → fail-open（不建单、不留冷却与占位）', async () => {
    const ctx = setup();
    ctx.replicaTargets.desiredReplicas.mockRejectedValue(new Error('pool snapshot down'));

    expect(() => ctx.service.maybeTrigger('file', 'f-1')).not.toThrow();
    await flush();

    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
    expect(ctx.service.pendingSize()).toBe(0);
    expect(ctx.service.cooldownSize()).toBe(0);
  });

  it('源锚点不可定位 → 不建单（与历史补偿同口径：宁可漏建，不建必然 blocked 的任务）', async () => {
    const ctx = setup({
      readyAccountIds: [],
      target: 2,
      descriptor: { ...DESCRIPTOR, chatId: null, messageId: null },
    });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.source.describe).toHaveBeenCalledWith('file', 'f-1');
    expect(ctx.trigger.onFileCommitted).not.toHaveBeenCalled();
  });

  it('已有同版本任务 / 终态任务（onFileCommitted 返回 false）→ 如实跳过，不重开终态', async () => {
    const ctx = setup({ readyAccountIds: ['bot-a'], target: 3, created: false });

    ctx.service.maybeTrigger('file', 'f-1');
    await flush();

    expect(ctx.trigger.onFileCommitted).toHaveBeenCalledTimes(1);
  });

  it('fail-open：副本查询异常与建单异常都不冒泡到下载调用方', async () => {
    const copiesFailure = setup({ copiesError: new Error('db down') });
    expect(() => copiesFailure.service.maybeTrigger('file', 'f-1')).not.toThrow();
    await flush();

    const triggerFailure = setup({ readyAccountIds: ['bot-a'], target: 2 });
    triggerFailure.trigger.onFileCommitted.mockRejectedValue(new Error('enqueue failed'));
    expect(() => triggerFailure.service.maybeTrigger('file', 'f-2')).not.toThrow();
    await flush();

    const describeFailure = setup({ readyAccountIds: ['bot-a'], target: 2, describeError: new Error('source down') });
    expect(() => describeFailure.service.maybeTrigger('file', 'f-3')).not.toThrow();
    await flush();
  });

  it('冷却表有容量上限：超过上限后仍可持续为不同文件打标（内存不随文件数无界增长）', () => {
    const ctx = setup();
    const mark = (id: string): void => (ctx.service as unknown as {
      markCoolingDown: (ownerId: string, at: number) => void;
    }).markCoolingDown(id, now);

    for (let i = 0; i < LAZY_TRIGGER_MAX_ENTRIES + 50; i += 1) mark(`f-${i}`);

    expect(ctx.service.cooldownSize()).toBeLessThanOrEqual(LAZY_TRIGGER_MAX_ENTRIES);
  });

  it('冷却表溢出时按插入顺序淘汰最旧条目，最新条目仍保留', () => {
    const ctx = setup();
    const internals = ctx.service as unknown as {
      markCoolingDown: (ownerId: string, at: number) => void;
      cooldown: Map<string, number>;
    };

    internals.markCoolingDown('oldest', now);
    for (let i = 0; i < LAZY_TRIGGER_MAX_ENTRIES; i += 1) internals.markCoolingDown(`f-${i}`, now);

    expect(internals.cooldown.has('oldest')).toBe(false);
    expect(internals.cooldown.has(`f-${LAZY_TRIGGER_MAX_ENTRIES - 1}`)).toBe(true);
    expect(ctx.service.cooldownSize()).toBe(LAZY_TRIGGER_MAX_ENTRIES);
  });
});

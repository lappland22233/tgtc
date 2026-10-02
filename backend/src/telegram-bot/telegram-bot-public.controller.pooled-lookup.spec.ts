import { Readable } from 'stream';
import { Request, Response } from 'express';
import { TelegramBotPublicController } from './telegram-bot-public.controller';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
import { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';

/**
 * Bot 直链池化回源的**真实数据流**回归（直击漏检根因）。
 *
 * 既有 `telegram-bot-public.controller.spec.ts` 把 `FileCopyService.findByAnchor` 整体 mock 成
 * 恒返回值，「锚点能否命中」这层从未被测；`file-copy.service.spec.ts` 的 upsertReady 与
 * findByAnchor 又各自单测、没有跨方法一致性用例。两条盲区叠加，才让「副本锚点被镜像群登记
 * 覆盖 → 私聊锚点反查恒空 → 池化退化为恒压源账号」长期全绿。
 *
 * 本文件用**真 FileCopyService**（装配内存 repo，按 where 精确匹配 + take 截断 + save 持久化）
 * 驱动真实控制器，覆盖线上形态：
 *   私聊登记（源账号，锚点=私聊）→ 镜像群登记（同 owner+account，锚点被覆盖成群）→
 *   直链下载仍按 `file_unique_id` 解析归属并池化回源。
 */

const VALID_TOKEN = 'A'.repeat(43);
const TOTAL_SIZE = 1000;
/** 与线上 grant 同形的 file_unique_id（内容标识，跨账号稳定） */
const FILE_UNIQUE_ID = 'AgADZQUAAvn-iEc';
const PRIVATE_CHAT_ID = '5648985656';
const PRIVATE_MESSAGE_ID = '665';
const MIRROR_GROUP_CHAT_ID = '-1004381979533';
const MIRROR_MESSAGE_ID = '4242';
const SOURCE_ACCOUNT_ID = '1111111';
const MIRROR_ACCOUNT_ID = '2222222';

type StoredCopy = Record<string, unknown>;

/**
 * 内存副本仓库：只实现 FileCopyService 实际用到的 TypeORM 子集
 * （find 的 where 精确匹配 + take、findOne、create、save 的 upsert 语义）。
 */
function createInMemoryCopyRepo() {
  const store: StoredCopy[] = [];
  let seq = 0;

  const whereMatches = (row: StoredCopy, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const find = jest.fn(async (options?: { where?: Record<string, unknown>; take?: number }) => {
    const where = options?.where ?? {};
    const rows = store.filter((row) => whereMatches(row, where));
    return options?.take != null ? rows.slice(0, options.take) : rows;
  });

  const findOne = jest.fn(async (options?: { where?: Record<string, unknown> }) => {
    const where = options?.where ?? {};
    return store.find((row) => whereMatches(row, where)) ?? null;
  });

  const create = jest.fn((value: StoredCopy) => ({ ...value }));

  const save = jest.fn(async (value: StoredCopy) => {
    const id = typeof value.id === 'string' ? value.id : '';
    if (!id) {
      seq += 1;
      value.id = `copy-${seq}`;
      store.push(value);
      return value;
    }
    const index = store.findIndex((row) => row.id === id);
    if (index >= 0) store[index] = value;
    else store.push(value);
    return value;
  });

  return {
    repo: {
      find,
      findOne,
      create,
      save,
      update: jest.fn(async () => ({ affected: 1 })),
      delete: jest.fn(async () => ({ affected: 0 })),
    },
    store,
  };
}

interface ScenarioOptions {
  /** grant 的 file_unique_id（默认 FILE_UNIQUE_ID）；传 null 模拟缺该列的历史 grant */
  fileUniqueId?: string | null;
}

/** 池化成功时 `openStream` 实际取到的账号（用于断言真实副本被消费而非替身返回值） */
function makeScenario(options: ScenarioOptions = {}) {
  const { repo, store } = createInMemoryCopyRepo();
  const copies = new FileCopyService(repo as never, { bumpCounter: jest.fn() } as never, null);

  const pickedAccountIds: string[] = [];
  let capturedError: unknown = null;

  const poolDownload = {
    isActive: jest.fn(() => true),
    inactiveReason: jest.fn(() => null),
    hasAccount: jest.fn(() => true),
    bumpCounter: jest.fn(),
    /**
     * 与 `AccountAwareDownloadService.openStream` 同口径：先按归属读 ready 副本集合，
     * 空集合即按 `no_ready_copies` 收口。下游流用替身，但**归属解析与副本读取全真**。
     */
    openStream: jest.fn(async (params: {
      ownerType: TelegramCopyOwnerType;
      ownerId: string;
      onUnavailable?: (failure: { reason: string; retryAfterMs?: number; readyAccountCount?: number }) => void;
    }) => {
      const ready = await copies.listReady(params.ownerType, params.ownerId);
      if (ready.length === 0) {
        params.onUnavailable?.({ reason: 'no_ready_copies', retryAfterMs: 5_000, readyAccountCount: 0 });
        return null;
      }
      const copy = ready[0];
      pickedAccountIds.push(copy.accountId);
      return {
        stream: Readable.from([Buffer.from('x')]),
        info: { file_id: copy.telegramFileId, file_size: TOTAL_SIZE },
        accountId: copy.accountId,
        copy,
        selectionReason: 'weighted',
      };
    }),
    openSourceStream: jest.fn(async (params: { accountId: string; fileId: string }) => ({
      stream: Readable.from([Buffer.from('x')]),
      info: { file_id: params.fileId, file_size: TOTAL_SIZE },
      accountId: params.accountId,
      copy: null,
      selectionReason: 'source-account-fallback',
    })),
  };

  const grantService = {
    findByToken: jest.fn(async () => ({
      id: 'grant-1',
      tokenPrefix: 'tgl_aaaaaaaa',
      telegramUserId: '7001',
      telegramFileId: 'grant-source-file-id',
      sourceAccountId: SOURCE_ACCOUNT_ID,
      chatId: PRIVATE_CHAT_ID,
      messageId: PRIVATE_MESSAGE_ID,
      fileUniqueId: options.fileUniqueId === undefined ? FILE_UNIQUE_ID : options.fileUniqueId,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: String(TOTAL_SIZE),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
    })),
    isActive: jest.fn(() => true),
    recordAccess: jest.fn(async () => undefined),
  };

  const telegramService = {
    getRealtimeFileStream: jest.fn(async () => ({
      stream: Readable.from([Buffer.from('x')]),
      info: { file_id: 'single-account', file_size: TOTAL_SIZE },
    })),
  };

  const fileCacheService = {
    getOrCacheStream: jest.fn(async (
      _key: string,
      _size: number,
      fetchFn: () => Promise<{ stream: Readable; info: { file_id: string; file_size: number } }>,
    ) => ({ stream: (await fetchFn()).stream, fromCache: false })),
    getOrCacheRangeStream: jest.fn(),
    getDirectOnlyStream: jest.fn(),
  };

  const rateLimitService = { checkAndIncrement: jest.fn(async () => ({ allowed: true })) };

  const streamResponder = {
    send: jest.fn(async () => undefined),
    handleError: jest.fn((_res: Response, error: unknown) => { capturedError = error; }),
  };

  const auditService = { log: jest.fn() };
  const configService = {
    get: jest.fn((key: string) => (key === 'TELEGRAM_BOT_TOKEN' ? '1234567:DEFAULT-TOKEN' : '')),
  };

  const controller = new TelegramBotPublicController(
    grantService as never,
    telegramService as never,
    fileCacheService as never,
    rateLimitService as never,
    streamResponder as never,
    auditService as never,
    poolDownload as never,
    copies as never,
    configService as never,
  );

  return {
    controller,
    copies,
    store,
    pickedAccountIds,
    poolDownload,
    telegramService,
    streamResponder,
    grantService,
    auditService,
    getCapturedError: () => capturedError,
  };
}

function makeRequest(): Request {
  return {
    headers: {},
    ips: [],
    ip: '203.0.113.7',
    socket: {},
    method: 'GET',
    originalUrl: `/api/bot-dl/${VALID_TOKEN}`,
    url: `/api/bot-dl/${VALID_TOKEN}`,
  } as unknown as Request;
}

const res = { set: jest.fn() } as unknown as Response;

/** 私聊入站登记（源账号持有私聊锚点副本） */
async function registerPrivateInbound(copies: FileCopyService, accountId = SOURCE_ACCOUNT_ID) {
  return copies.upsertReady({
    ownerType: 'fileUnique',
    ownerId: FILE_UNIQUE_ID,
    accountId,
    telegramFileId: `${accountId}-file-id`,
    chatId: PRIVATE_CHAT_ID,
    messageId: PRIVATE_MESSAGE_ID,
    fileSize: TOTAL_SIZE,
    source: 'inbound',
  });
}

/** 镜像群内的登记：同一 (owner, account) 行锚点被覆盖成群锚点 */
async function registerMirrorGroupCopy(copies: FileCopyService, accountId: string) {
  return copies.upsertReady({
    ownerType: 'fileUnique',
    ownerId: FILE_UNIQUE_ID,
    accountId,
    telegramFileId: `${accountId}-file-id`,
    chatId: MIRROR_GROUP_CHAT_ID,
    messageId: MIRROR_MESSAGE_ID,
    fileSize: TOTAL_SIZE,
    source: 'relayed',
  });
}

describe('TelegramBotPublicController 池化回源（真副本表 + 内存 repo）', () => {
  it('私聊登记 → 镜像群登记覆盖锚点：直链下载仍按 file_unique_id 池化回源', async () => {
    const ctx = makeScenario();

    // 1) 用户在私聊把文件发给 Bot：源账号登记私聊锚点副本
    await registerPrivateInbound(ctx.copies);
    // 2) 镜像扩散跑通：同一账号在镜像群再次登记（锚点被覆盖），另一个群内 Bot 也登记自己账号的副本
    await registerMirrorGroupCopy(ctx.copies, SOURCE_ACCOUNT_ID);
    await registerMirrorGroupCopy(ctx.copies, MIRROR_ACCOUNT_ID);

    // 根因固化：锚点确已被镜像群登记覆盖
    expect(ctx.store[0].chatId).toBe(MIRROR_GROUP_CHAT_ID);
    expect(ctx.store[0].messageId).toBe(MIRROR_MESSAGE_ID);
    // 旧读端语义（按私聊入站锚点反查）此刻恒空——这正是线上「池化退化为恒压源账号」的成因
    expect(await ctx.copies.findByAnchor(PRIVATE_CHAT_ID, PRIVATE_MESSAGE_ID)).toBeNull();
    // 修复后读端目标：按 file_unique_id 归属仍可取到全部 ready 副本
    expect((await ctx.copies.listReady('fileUnique', FILE_UNIQUE_ID)).map((row) => row.accountId).sort())
      .toEqual([SOURCE_ACCOUNT_ID, MIRROR_ACCOUNT_ID].sort());

    // 3) 用户点击直链：控制器必须仍走池化回源，而不是因锚点失配回退源账号
    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.poolDownload.openStream).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'fileUnique',
      ownerId: FILE_UNIQUE_ID,
    }));
    expect(ctx.pickedAccountIds).toEqual([SOURCE_ACCOUNT_ID]);
    expect(ctx.poolDownload.openSourceStream).not.toHaveBeenCalled();
    expect(ctx.telegramService.getRealtimeFileStream).not.toHaveBeenCalled();
    expect(ctx.streamResponder.send).toHaveBeenCalledTimes(1);
    expect(ctx.getCapturedError()).toBeNull();
  });

  it('历史 grant 缺 file_unique_id 且锚点未被覆盖：仍按入站锚点反查并池化回源', async () => {
    const ctx = makeScenario({ fileUniqueId: null });

    await registerPrivateInbound(ctx.copies);

    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    // 兜底路径：按私聊入站锚点反查出 fileUnique 归属，池化仍然成立
    expect(ctx.poolDownload.openStream).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'fileUnique',
      ownerId: FILE_UNIQUE_ID,
    }));
    expect(ctx.poolDownload.openSourceStream).not.toHaveBeenCalled();
    expect(ctx.getCapturedError()).toBeNull();
  });

  it('历史 grant 缺 file_unique_id 且锚点已被覆盖：池化不可用，按回退矩阵降级到源账号', async () => {
    // 这是修复后**仅存**的降级形态：只带私聊锚点、又不带内容标识的历史 grant，
    // 在镜像群登记覆盖锚点后无从解析归属，只能回退「恒压源账号」单路回源。
    const ctx = makeScenario({ fileUniqueId: null });

    await registerPrivateInbound(ctx.copies);
    await registerMirrorGroupCopy(ctx.copies, SOURCE_ACCOUNT_ID);

    await ctx.controller.download(VALID_TOKEN, makeRequest(), res);

    expect(ctx.poolDownload.openStream).not.toHaveBeenCalled();
    expect(ctx.poolDownload.openSourceStream).toHaveBeenCalledWith(expect.objectContaining({
      accountId: SOURCE_ACCOUNT_ID,
    }));
    expect(ctx.getCapturedError()).toBeNull();
  });
});

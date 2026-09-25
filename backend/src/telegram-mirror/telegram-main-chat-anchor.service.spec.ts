/**
 * 回归保护：主群锚点的**幂等**与**fail-closed**。
 *
 * 事故形态（本用例存在的理由）：
 * - Bot API `forwardMessage` 没有幂等键，同一文件对 N 条启用规则各建一条任务，
 *   若锚点不共享/不落库，主群会被搬运出 N 条重复消息；
 * - 主群未配置、多规则源群不一致、主群是私聊时若「挑一条规则继续跑」，
 *   会把文件扩散到错误的中转落点，且后台看不出原因。
 */
import { Logger } from '@nestjs/common';
import { TelegramMainChatAnchorService, PLANT_RESERVATION_LEASE_MS } from './telegram-main-chat-anchor.service';
import { backoffMsFor } from './telegram-mirror.errors';
import { MIRROR_MAX_ATTEMPTS } from './telegram-mirror.types';

describe('TelegramMainChatAnchorService（主群锚点幂等与阻塞口径）', () => {
  const MAIN = '-100999';

  function setup(options: {
    /** 每条规则的源群（主群候选）；多于一个不同值即「配置冲突」 */
    ruleSources?: string[];
    /** 没有启用规则 */
    noEnabledRule?: boolean;
    panelAccounts?: Array<{ id: string; accountId: string; token: string }>;
    forwardError?: Error;
    /** 锚点表读失败（模拟库故障） */
    repoReadError?: Error;
    /** 锚点表**预留写入**失败（非唯一键冲突，模拟库故障/磁盘写失败） */
    repoInsertError?: Error;
    clientWired?: boolean;
  } = {}) {
    const rows = new Map<string, Record<string, any>>();
    let seq = 0;
    const repo = {
      findOne: jest.fn(async ({ where }: { where: { ownerType: string; ownerId: string } }) => {
        if (options.repoReadError) throw options.repoReadError;
        const row = rows.get(`${where.ownerType}:${where.ownerId}`);
        return row ? { ...row } : null;
      }),
      create: jest.fn((payload: Record<string, any>) => ({ ...payload })),
      insert: jest.fn(async (payload: Record<string, any>) => {
        if (options.repoInsertError) throw options.repoInsertError;
        const key = `${payload.ownerType}:${payload.ownerId}`;
        if (rows.has(key)) throw new Error('UNIQUE constraint failed: telegram_main_chat_anchors.ownerType');
        rows.set(key, { id: `anchor-${++seq}`, ...payload });
      }),
      update: jest.fn(async (where: { id?: string; status?: any }, payload: Record<string, any>) => {
        for (const [key, row] of rows) {
          if (where.id && row.id !== where.id) continue;
          // 支持 `status: Not('ready')` 这类条件（失败收口不得覆盖已成功的锚点）
          const condition = where.status;
          if (condition && typeof condition === 'object') {
            if (condition.type === 'not' && row.status === condition.value) continue;
            if (condition.type !== 'not' && row.status !== condition.value) continue;
          } else if (condition && row.status !== condition) {
            continue;
          }
          rows.set(key, { ...row, ...payload });
        }
      }),
      // 接管是「删旧行 + 重新插入」（唯一键 CAS）：删除条件带 status，模拟 SQL 的 WHERE。
      delete: jest.fn(async (where: { id?: string; status?: string }) => {
        for (const [key, row] of rows) {
          if (where.id && row.id !== where.id) continue;
          if (where.status && row.status !== where.status) continue;
          rows.delete(key);
        }
      }),
    };

    const sources = options.ruleSources ?? [MAIN];
    const listEnabledRules = jest.fn(async () => (options.noEnabledRule
      ? []
      : sources.map((sourceChatId, index) => ({
        id: `rule-${index}`,
        enabled: true,
        sourceChatId,
        targetChatId: `-10088${index}`,
      }))));
    // 用最小实现复刻 `TelegramMirrorConfigService.resolveMainChatId` 的口径：
    // 无启用规则 / 无源群 → main_chat_missing；源群不一致 → main_chat_conflict。
    const resolveMainChatId = jest.fn(async (): Promise<
      { ok: true; chatId: string } | { ok: false; code: 'main_chat_missing' | 'main_chat_conflict'; summary: string }
    > => {
      const rules = await listEnabledRules();
      if (rules.length === 0) {
        return { ok: false, code: 'main_chat_missing', summary: '没有启用中的镜像规则，未配置主群（中转落点）' };
      }
      const unique = Array.from(new Set(rules.map((rule) => rule.sourceChatId).filter(Boolean)));
      if (unique.length === 0) {
        return { ok: false, code: 'main_chat_missing', summary: '启用中的镜像规则未配置源群（主群），副本扩散缺少中转落点' };
      }
      if (unique.length > 1) {
        return { ok: false, code: 'main_chat_conflict', summary: `启用中的镜像规则配置了 ${unique.length} 个不同的源群（主群）` };
      }
      return { ok: true, chatId: unique[0] };
    });
    const config = { listEnabledRules, resolveMainChatId };

    const client = {
      forwardMessage: jest.fn(async () => {
        if (options.forwardError) throw options.forwardError;
        return { messageId: '777' };
      }),
    };
    const pool = {
      getConfig: jest.fn((id: string) => (id === '1234567'
        ? { id, token: '1234567:SECRET', chatId: '-100555', weight: 1, maxInflight: 8, enabled: true }
        : null)),
      bumpCounter: jest.fn(),
    };
    const accounts = {
      resolveEnabledBotAccounts: jest.fn(async () => options.panelAccounts ?? []),
    };
    const env: Record<string, string> = { TELEGRAM_BOT_TOKEN: '1234567:AAAA' };
    const configService = { get: jest.fn((key: string) => env[key]) };

    const service = new TelegramMainChatAnchorService(
      repo as never,
      config as never,
      (options.clientWired === false ? null : client) as never,
      pool as never,
      accounts as never,
      configService as never,
    );
    return { service, repo, client, pool, rows };
  }

  it('主群未配置时 blocked，不执行任何搬运', async () => {
    const { service, client } = setup({ noEnabledRule: true });

    await expect(service.ensureAnchor({
      ownerType: 'grant',
      ownerId: 'g1',
      sourceChatId: '12345',
      sourceMessageId: '9',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'main_chat_missing', kind: 'blocked' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('多条启用规则的源群不一致时 blocked（不猜第一个），避免多中转落点', async () => {
    const { service, client } = setup({ ruleSources: ['-100999', '-100777'] });

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'main_chat_conflict', kind: 'blocked' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('主群被配置成私聊时 blocked', async () => {
    const { service, client } = setup({ ruleSources: ['12345'] });

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'main_chat_invalid', kind: 'blocked' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('缺源锚点时 blocked（不允许随机挑账号试）', async () => {
    const { service, client } = setup();

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '',
      sourceMessageId: '',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'source_message_unresolved', kind: 'blocked' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('Bot 私聊来源：由持有该消息的账号搬运一次，锚点写回主群消息', async () => {
    const { service, client, rows, pool } = setup();

    const anchor = await service.ensureAnchor({
      ownerType: 'grant',
      ownerId: 'g1',
      sourceChatId: '12345',
      sourceMessageId: '9',
      sourceAccountId: '1234567',
    });

    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(client.forwardMessage).toHaveBeenCalledWith('1234567', '1234567:SECRET', MAIN, '12345', '9');
    expect(anchor).toEqual({ chatId: MAIN, messageId: '777', planted: true });
    expect(rows.get('grant:g1')).toMatchObject({
      anchorChatId: MAIN,
      anchorMessageId: '777',
      plantedByAccountId: '1234567',
      sourceChatId: '12345',
      status: 'ready',
    });
    expect(pool.bumpCounter).toHaveBeenCalledWith('mainChatPlantAttempts');
  });

  it('重复调用复用已落库锚点：不产生主群重复消息', async () => {
    const { service, client } = setup();
    const input = {
      ownerType: 'grant' as const,
      ownerId: 'g1',
      sourceChatId: '12345',
      sourceMessageId: '9',
      sourceAccountId: '1234567',
    };

    const first = await service.ensureAnchor(input);
    const second = await service.ensureAnchor(input);

    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(first.planted).toBe(true);
    expect(second).toEqual({ chatId: MAIN, messageId: '777', planted: false });
  });

  it('并发调用（多规则各一条任务）只搬运一次', async () => {
    const { service, client } = setup();
    const input = {
      ownerType: 'file' as const,
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    };

    const [a, b] = await Promise.all([service.ensureAnchor(input), service.ensureAnchor(input)]);

    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(a.messageId).toBe('777');
    expect(b.messageId).toBe('777');
  });

  it('源消息已在主群：不搬运，直接登记锚点', async () => {
    const { service, client, rows } = setup();

    const anchor = await service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: MAIN,
      sourceMessageId: '5',
      sourceAccountId: '1234567',
    });

    expect(client.forwardMessage).not.toHaveBeenCalled();
    expect(anchor).toEqual({ chatId: MAIN, messageId: '5', planted: false });
    expect(rows.get('file:f1')).toMatchObject({ anchorMessageId: '5', status: 'ready' });
  });

  it('搬运失败：原错误抛给上游分类，并把失败原因留痕（不写可用锚点）', async () => {
    const failure = Object.assign(new Error('Bad Request: not enough rights to send'), { kind: 'unavailable', name: 'TelegramAccountError' });
    const { service, rows, pool } = setup({ forwardError: failure });

    await expect(service.ensureAnchor({
      ownerType: 'grant',
      ownerId: 'g1',
      sourceChatId: '12345',
      sourceMessageId: '9',
      sourceAccountId: '1234567',
    })).rejects.toBe(failure);

    expect(rows.get('grant:g1')).toMatchObject({
      status: 'failed',
      anchorMessageId: null,
      lastError: expect.stringContaining('not enough rights'),
    });
    expect(pool.bumpCounter).toHaveBeenCalledWith('mainChatPlantFailures');
  });

  it('锚点表读取失败时按 blocked 中止，避免重复搬运', async () => {
    const { service, client } = setup({ repoReadError: new Error('SQLITE_BUSY: database is locked') });

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'main_chat_anchor_unavailable', kind: 'blocked' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('找不到持有消息的 Bot 凭据时 blocked（绝不跨账号代搬）', async () => {
    const { service, client } = setup();

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: 'unknown-account',
    })).rejects.toMatchObject({ code: 'main_chat_bot_unresolved', kind: 'blocked' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('先落库再执行：预留写入失败（非唯一键冲突）时 blocked，绝不先搬运', async () => {
    // 没有预留就搬运 = 失去幂等保护（崩溃/重试会再搬一次并在主群留下重复消息）
    const { service, client } = setup({ repoInsertError: new Error('SQLITE_BUSY: database is locked') });

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'main_chat_anchor_unavailable', kind: 'blocked' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('已有 pending 预留（租约内）时不重复搬运：按可重试失败等租约到期', async () => {
    const { service, client, rows } = setup();
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: null,
      status: 'pending',
      plantedAt: new Date(),
    });

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'main_chat_anchor_pending', kind: 'retryable' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('pending 超出租约（上次落库前中断的残留）时接管重搬，并计入接管计数', async () => {
    const { service, client, rows, pool } = setup();
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: null,
      status: 'pending',
      plantedAt: new Date(Date.now() - 6 * 60_000),
    });

    const anchor = await service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    });

    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(anchor).toEqual({ chatId: MAIN, messageId: '777', planted: true });
    expect(pool.bumpCounter).toHaveBeenCalledWith('mainChatPlantTakeovers');
    expect(rows.get('file:f1')).toMatchObject({ status: 'ready', anchorMessageId: '777' });
  });

  it('上次搬运失败（failed）时立即接管重搬：失败无副作用残留，不必等租约', async () => {
    const { service, client, rows, pool } = setup();
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: null,
      status: 'failed',
      lastError: 'Bad Request: not enough rights',
      plantedAt: null,
    });

    const anchor = await service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    });

    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(anchor.planted).toBe(true);
    expect(pool.bumpCounter).not.toHaveBeenCalledWith('mainChatPlantTakeovers');
    expect(rows.get('file:f1')).toMatchObject({ status: 'ready', lastError: null });
  });

  it('主群配置变更（锚点指向旧主群）时重新搬运一次，并计入接管计数（留痕）', async () => {
    const { service, client, rows, pool } = setup();
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: '-100777',
      anchorMessageId: '555',
      status: 'ready',
      plantedAt: new Date(Date.now() - 60_000),
    });

    const anchor = await service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    });

    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(anchor).toEqual({ chatId: MAIN, messageId: '777', planted: true });
    expect(pool.bumpCounter).toHaveBeenCalledWith('mainChatPlantTakeovers');
    expect(rows.get('file:f1')).toMatchObject({
      anchorChatId: MAIN,
      anchorMessageId: '777',
      status: 'ready',
    });
  });

  it('file 归属同一源消息重复调用：复用既有锚点，forwardMessage 只调用一次', async () => {
    const { service, client } = setup();
    const input = {
      ownerType: 'file' as const,
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
      sourceVersion: 1,
    };

    const first = await service.ensureAnchor(input);
    const second = await service.ensureAnchor(input);

    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(first.planted).toBe(true);
    expect(second).toEqual({ chatId: MAIN, messageId: '777', planted: false });
  });

  it('file 归属源消息变更（覆盖上传）时不再复用旧锚点：重新搬运并更新源指纹', async () => {
    const { service, client, rows, pool } = setup();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await service.ensureAnchor({
        ownerType: 'file', ownerId: 'f1', sourceChatId: '-100555', sourceMessageId: '3',
        sourceAccountId: '1234567', sourceVersion: 1,
      });

      const anchor = await service.ensureAnchor({
        ownerType: 'file', ownerId: 'f1', sourceChatId: '-100555', sourceMessageId: '4',
        sourceAccountId: '1234567', sourceVersion: 2,
      });

      // 旧主群消息指向 v1 内容，必须按 v2 的源消息重新搬运一次（forwardMessage 两次），
      // 否则镜像群会从旧消息中继、拿到旧内容而任务记为成功
      expect(client.forwardMessage).toHaveBeenCalledTimes(2);
      expect(anchor).toEqual({ chatId: MAIN, messageId: '777', planted: true });
      expect(rows.get('file:f1')).toMatchObject({
        status: 'ready',
        anchorChatId: MAIN,
        anchorMessageId: '777',
        sourceChatId: '-100555',
        sourceMessageId: '4',
      });
      // 日志必须与「主群变更」区分：输出源内容变更专用 warn，便于运维定位重搬原因
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('源消息已变更'));
      expect(pool.bumpCounter).toHaveBeenCalledWith('mainChatPlantTakeovers');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fileUnique 归属源消息变化时仍复用（逻辑主键即内容指纹），不触发无意义重搬', async () => {
    const { service, client } = setup();
    await service.ensureAnchor({
      ownerType: 'fileUnique', ownerId: 'UNIQ-1', sourceChatId: '-100555', sourceMessageId: '3',
      sourceAccountId: '1234567',
    });

    const anchor = await service.ensureAnchor({
      ownerType: 'fileUnique', ownerId: 'UNIQ-1', sourceChatId: '-100555', sourceMessageId: '4',
      sourceAccountId: '1234567',
    });

    // 不同副本消息指向同一内容：沿用既有复用语义，避免因副本行顺序变化在主群留下重复消息
    expect(client.forwardMessage).toHaveBeenCalledTimes(1);
    expect(anchor).toEqual({ chatId: MAIN, messageId: '777', planted: false });
  });

  it('传入指纹缺失（sourceMessageId 为空）时判据视为匹配，沿用既有复用语义', () => {
    const { service } = setup();
    // `ensureAnchor` 对空源定位有既有的 `source_message_unresolved` 拦截（校验先于复用判定），
    // 该分支只能从并发接管路径触达，因此这里直接断言判据本身：缺失信息不等于内容变更。
    const predicate = (service as unknown as {
      isSourceFingerprintMatch: (input: unknown, row: unknown) => boolean;
    }).isSourceFingerprintMatch.bind(service);
    const row = { sourceChatId: '-100555', sourceMessageId: '3' };

    expect(predicate({ ownerType: 'file', ownerId: 'f1', sourceChatId: '-100555', sourceMessageId: null }, row)).toBe(true);
    expect(predicate({ ownerType: 'file', ownerId: 'f1', sourceChatId: null, sourceMessageId: null }, row)).toBe(true);
  });

  it('存量锚点缺少源指纹（历史行）时公开入口沿用复用语义：不触发重搬', async () => {
    const { service, client, rows } = setup();
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: '777',
      // 历史锚点行没有源指纹（列曾为空）→ 缺失信息不等于内容变更，必须继续复用
      sourceChatId: null,
      sourceMessageId: null,
      status: 'ready',
      plantedAt: new Date(),
    });

    const anchor = await service.ensureAnchor({
      ownerType: 'file', ownerId: 'f1', sourceChatId: '-100555', sourceMessageId: '3',
      sourceAccountId: '1234567',
    });

    expect(client.forwardMessage).not.toHaveBeenCalled();
    expect(anchor).toEqual({ chatId: MAIN, messageId: '777', planted: false });
  });

  it('接管竞态：另一个执行者已抢到预留（唯一键挡住本调用）时不重复搬运', async () => {
    const { service, client, repo, rows } = setup();
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: null,
      status: 'pending',
      plantedAt: new Date(Date.now() - 6 * 60_000),
    });
    // 模拟「另一个执行者已用唯一键 CAS 抢到预留」：本调用的删旧行匹配不到（id 已变），
    // 插入随即撞唯一键 → 必须回读并按可重试收口，绝不带着过期判断去转发。
    repo.delete.mockResolvedValue(undefined as never);

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    })).rejects.toMatchObject({ code: 'main_chat_anchor_pending', kind: 'retryable' });
    expect(client.forwardMessage).not.toHaveBeenCalled();
  });

  it('并发回读的 ready 锚点若指向旧内容（更早版本任务抢先搬运），按可重试收口而非复用', async () => {
    const { service, client, repo, rows } = setup();
    // 存量锚点：ready 且已指向主群，但源消息是**旧内容**（sourceMessageId=3）。
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: '999',
      status: 'ready',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      plantedAt: new Date(Date.now() - 60_000),
    });
    // 模拟并发执行者已抢到预留：本调用的删旧行匹配不到（对方行 id 不同），
    // 插入随即撞唯一键 → 回读到的 ready 行仍指向旧内容。
    repo.delete.mockResolvedValue(undefined as never);

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '4', // 新内容（覆盖上传后的源消息）
      sourceAccountId: '1234567',
      sourceVersion: 2,
    })).rejects.toMatchObject({ code: 'main_chat_anchor_pending', kind: 'retryable' });
    // 绝不复用指向旧内容的锚点，也不在竞态下贸然再搬一次（下一轮由接管路径重搬）
    expect(client.forwardMessage).not.toHaveBeenCalled();
    expect(rows.get('file:f1')).toMatchObject({ anchorMessageId: '999', sourceMessageId: '3' });
  });

  it('租约内的 pending 必须把重试排到租约到期之后（否则最后一次重试仍会撞预留）', async () => {
    const { service, rows } = setup();
    const reservedAt = new Date(Date.now() - 60_000); // 预留 1 分钟前写入
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: null,
      status: 'pending',
      plantedAt: reservedAt,
    });

    const error = await service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    }).then(
      () => { throw new Error('应当抛出 main_chat_anchor_pending'); },
      (thrown: { code: string; retryAfterMs?: number }) => thrown,
    );

    expect(error).toMatchObject({ code: 'main_chat_anchor_pending', kind: 'retryable' });
    // 重试延迟必须 ≥ 租约剩余时间：默认退避（最后一次仅 240s）会小于租约剩余，
    // 那样下一次尝试仍撞在未到期的预留上，任务耗尽重试、锚点长期 pending。
    const remainingMs = reservedAt.getTime() + PLANT_RESERVATION_LEASE_MS - Date.now();
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(remainingMs);
  });

  it('租约到期后被接管并搬运成功的锚点，不会被更早那次失败改写成 failed', async () => {
    const { service, client, rows } = setup();
    rows.set('file:f1', {
      id: 'anchor-0',
      ownerType: 'file',
      ownerId: 'f1',
      anchorChatId: MAIN,
      anchorMessageId: null,
      status: 'pending',
      plantedAt: new Date(Date.now() - 6 * 60_000), // 已超租约：本调用接管重搬
    });
    // 模拟「本次转发失败，但在此之前另一个执行者已接管并搬运成功」：
    // 行在 persistFailed 落库前被收口为 ready。
    client.forwardMessage.mockImplementation(async () => {
      rows.set('file:f1', {
        ...rows.get('file:f1'),
        status: 'ready',
        anchorChatId: MAIN,
        anchorMessageId: '999',
        lastError: null,
      });
      throw new Error('Bad Request: message to forward not found');
    });

    await expect(service.ensureAnchor({
      ownerType: 'file',
      ownerId: 'f1',
      sourceChatId: '-100555',
      sourceMessageId: '3',
      sourceAccountId: '1234567',
    })).rejects.toThrow('message to forward not found');

    // 成功锚点必须原样保留（否则下次重试会「立即接管重搬」→ 主群多一条重复消息）
    expect(rows.get('file:f1')).toMatchObject({
      status: 'ready',
      anchorMessageId: '999',
      lastError: null,
    });
  });

  it('预留租约必须短于任务的完整重试预算（否则锚点会长期停在 pending）', () => {
    // 租约内的重复触发只会得到 `main_chat_anchor_pending/retryable`，任务必须还能再重试
    // 一次才能等到租约到期自动接管。这里把「租约 < 重试预算」固化成断言：任何一方被调大
    // （例如把租约改到 10 分钟、或把重试退避改小）都会在这里失败，而不是在生产上表现为
    // 「任务耗尽重试 + 锚点永久 pending」。
    let retryBudgetMs = 0;
    for (let attempt = 1; attempt < MIRROR_MAX_ATTEMPTS; attempt += 1) {
      retryBudgetMs += backoffMsFor(attempt);
    }
    expect(retryBudgetMs).toBeGreaterThan(PLANT_RESERVATION_LEASE_MS);
  });
});

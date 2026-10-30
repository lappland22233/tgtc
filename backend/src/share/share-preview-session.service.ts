import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SharePreviewSession } from '../common/entities/share-preview-session.entity';
import { ShareLink, ShareLinkStatus } from '../common/entities/share-link.entity';
import { databaseQuery, getDatabaseType } from '../database/database-types';

/** 预览会话窗口：与 access JWT 5 分钟有效期对齐 */
const PREVIEW_SESSION_WINDOW_MS = 5 * 60 * 1000;
/** 每次消费尝试时触发的过期清理概率（1/50），限制请求路径开销 */
const PRUNE_CHANCE = 50;
/** 单次批量清理条数上限 */
const PRUNE_BATCH_LIMIT = 200;

/**
 * 服务端分享预览会话（C-03 修复核心）。
 *
 * 替代 ShareService 内进程级 `previewSessions` Map：
 * - 会话外置到 PostgreSQL，唯一约束 (shareLinkId, fileId, visitorHash) 保证多实例原子性；
 * - 分享行锁与事务串行化「会话确认 + 额度消费」：
 *   并发首访在同一分享行上排队，后续请求读取已提交会话后幂等免扣；
 * - 首次成功返回文件字节前必须完成会话确认，同会话后续 Range / 重连幂等免扣；
 * - 会话过期后再次预览视为新会话，重新扣次。
 */
@Injectable()
export class SharePreviewSessionService {
  private readonly logger = new Logger(SharePreviewSessionService.name);
  private sinceLastPrune = 0;
  private sqliteChain: Promise<void> = Promise.resolve();

  constructor(
    @InjectRepository(SharePreviewSession)
    private readonly sessionRepo: Repository<SharePreviewSession>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 消费一次分享预览访问：
   * - 返回 'consumed'：本次为首访（创建/续期了会话并扣减一次 maxAccessCount）。
   * - 返回 'idempotent'：同访客同窗口内已有有效会话，幂等免扣。
   * - 返回 'exhausted'：额度已耗尽（会话已回滚，不落库）。
   *
   * 首次返回文件字节之前调用；调用失败/耗尽时上层必须拒绝输出任何字节。
   *
   * @param link 已通过可用性/密码/归属校验的分享链接
   * @param fileId 目标文件 ID
   * @param visitorHash 访客会话标识（高熵 Cookie）的 sha256 摘要
   */
  async consumePreviewAccess(
    link: ShareLink,
    fileId: string,
    visitorHash: string,
  ): Promise<'consumed' | 'idempotent' | 'exhausted'> {
    // 低频触发过期清理（走 expiresAt 索引，分批删除，禁止请求路径全表扫描）
    if (++this.sinceLastPrune >= PRUNE_CHANCE) {
      this.sinceLastPrune = 0;
      this.pruneExpired().catch((err) =>
        this.logger.warn(`预览会话过期清理失败: ${(err as Error).message}`),
      );
    }

    const consume = () => this.dataSource.transaction(async (manager) => {
      const links = manager.getRepository(ShareLink);
      // 锁住分享行后，再确认会话与扣次。并发重试不得看到“会话已建但尚未扣次”。
      const current = await links.findOne({
        where: { id: link.id, isDeleted: false },
        ...(this.dataSource.options.type === 'postgres'
          ? { lock: { mode: 'pessimistic_write' as const } } : {}),
      });
      const now = Date.now();
      const expiresAt = new Date(now + PREVIEW_SESSION_WINDOW_MS);
      if (!current || current.status === ShareLinkStatus.DISABLED) {
        throw new NotFoundException('分享已取消或不可用');
      }
      if (current.expiresIn && current.expiresStartAt
        && current.expiresStartAt.getTime() + current.expiresIn * 3600000 <= now) {
        throw new NotFoundException('分享已过期');
      }
      const sessions = manager.getRepository(SharePreviewSession);
      const identity = { shareLinkId: link.id, fileId, visitorHash };
      const existing = await sessions.findOne({ where: identity });
      if (existing?.consumed && existing.expiresAt.getTime() > now) return 'idempotent' as const;

      const updated = await links.createQueryBuilder()
        .update(ShareLink)
        .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
        .where('id = :id', { id: link.id })
        .andWhere('"isDeleted" = false')
        .andWhere('("maxAccessCount" < 0 OR "currentAccessCount" < "maxAccessCount")')
        .execute();
      if (!updated.affected) return 'exhausted' as const;

      // save 不依赖驱动特定的 QueryBuilder.returning；失败时额度与会话一并回滚。
      await sessions.save(sessions.create({ ...existing, ...identity, consumed: true, expiresAt }));
      return 'consumed' as const;
    });
    if (this.dataSource.options.type !== 'sqlite') return consume();

    // sqlite3 共用单连接，禁止本服务并发开启嵌套事务；跨进程仍由 SQLite 写锁保护。
    const previous = this.sqliteChain;
    let release!: () => void;
    this.sqliteChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await consume();
    } finally {
      release();
    }
  }

  /**
   * 分批清理过期会话（按 expiresAt 索引，上限 PRUNE_BATCH_LIMIT）。
   * 供请求路径低频触发与运维脚本共用；不做全表扫描。
   */
  async pruneExpired(limit = PRUNE_BATCH_LIMIT): Promise<number> {
    const now = new Date();
    const sub = this.sessionRepo
      .createQueryBuilder()
      .select('id')
      .where('"expiresAt" < :now', { now })
      .orderBy('"expiresAt"', 'ASC')
      .limit(limit)
      .getQuery();
    // G5-05：sub 查询含 $1 占位符，必须把参数一并传入，
    // 否则 PostgreSQL 会因参数缺失报错，被 catch 吞掉后过期会话永不清理。
    // PERF-B-102：删除计数必须经 databaseQuery + RETURNING 按返回行数统计——
    // PG 的 DELETE 返回 [rows, count] 元组，affected 归一化后被丢弃；SQLite 下原
    // result[1] 恒为 undefined → 清理计数恒为 0（不可观测）。两方言统一按返回行数统计。
    const prunedRows = await databaseQuery<Array<{ id: string }>>(
      this.sessionRepo.manager,
      `DELETE FROM "share_preview_sessions" WHERE "id" IN (${sub}) RETURNING "id"`,
      [now],
      getDatabaseType(),
    );
    return Array.isArray(prunedRows) ? prunedRows.length : 0;
  }
}

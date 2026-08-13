import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SharePreviewSession } from '../common/entities/share-preview-session.entity';
import { ShareLink } from '../common/entities/share-link.entity';

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
 * - 「创建/续期会话」与「额度消费」按顺序执行，借助唯一约束天然并发安全：
 *   并发首访只有一条 INSERT 成功（另一条 ON CONFLICT 幂等），杜绝重复扣次；
 * - 首次成功返回文件字节前必须完成会话确认，同会话后续 Range / 重连幂等免扣；
 * - 会话过期后再次预览视为新会话，重新扣次。
 */
@Injectable()
export class SharePreviewSessionService {
  private readonly logger = new Logger(SharePreviewSessionService.name);
  private sinceLastPrune = 0;

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
    const now = Date.now();
    const expiresAt = new Date(now + PREVIEW_SESSION_WINDOW_MS);

    // 低频触发过期清理（走 expiresAt 索引，分批删除，禁止请求路径全表扫描）
    if (++this.sinceLastPrune >= PRUNE_CHANCE) {
      this.sinceLastPrune = 0;
      this.pruneExpired().catch((err) =>
        this.logger.warn(`预览会话过期清理失败: ${(err as Error).message}`),
      );
    }

    // 第一步：续期已过期会话（过期后再次预览视为新会话）。
    // 受行锁保护：并发下只有一条 UPDATE 成功，其余 affected=0 落到幂等分支。
    const renewed = await this.sessionRepo
      .createQueryBuilder()
      .update()
      .set({ expiresAt })
      .where('"shareLinkId" = :linkId', { linkId: link.id })
      .andWhere('"fileId" = :fileId', { fileId })
      .andWhere('"visitorHash" = :visitorHash', { visitorHash })
      .andWhere('"expiresAt" <= :now', { now: new Date(now) })
      .execute();

    if (renewed.affected) {
      return this.consumeOrCompensate(link, fileId, visitorHash);
    }

    // 第二步：尝试插入新会话；唯一冲突表示已有未过期会话 → 幂等免扣。
    let inserted = false;
    try {
      const result = await this.sessionRepo
        .createQueryBuilder()
        .insert()
        .values({ shareLinkId: link.id, fileId, visitorHash, consumed: true, expiresAt })
        .orIgnore()
        .execute();
      inserted = (result.identifiers?.length ?? 0) > 0;
    } catch {
      // orIgnore 唯一冲突在部分驱动/配置下可能以异常形式暴露，按幂等处理
      inserted = false;
    }

    if (!inserted) return 'idempotent';
    return this.consumeOrCompensate(link, fileId, visitorHash);
  }

  /**
   * 扣减一次额度；失败（耗尽）时补偿删除刚创建/续期的会话，保证不残留占用。
   * 补偿删除只作用于「本方法本次建立的会话」：续期分支影响的是已存在行，
   * 删除后该行消失，下次访问会重新创建并扣次，与「耗尽拒绝」语义一致。
   */
  private async consumeOrCompensate(
    link: ShareLink,
    fileId: string,
    visitorHash: string,
  ): Promise<'consumed' | 'exhausted'> {
    // 复用 ShareService 的原子扣次语义：maxAccessCount < 0 不限；否则仅当未达上限才 +1。
    if (link.maxAccessCount < 0) {
      await this.dataSource
        .createQueryBuilder()
        .update(ShareLink)
        .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
        .where('id = :id', { id: link.id })
        .andWhere('"isDeleted" = false')
        .execute();
      return 'consumed';
    }

    const result = await this.dataSource
      .createQueryBuilder()
      .update(ShareLink)
      .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
      .where('id = :id', { id: link.id })
      .andWhere('"isDeleted" = false')
      .andWhere('"currentAccessCount" < "maxAccessCount"')
      .execute();

    if (!result.affected) {
      // 额度耗尽：补偿删除本次会话记录（保持无残留），返回 exhausted。
      await this.sessionRepo
        .createQueryBuilder()
        .delete()
        .where('"shareLinkId" = :linkId', { linkId: link.id })
        .andWhere('"fileId" = :fileId', { fileId })
        .andWhere('"visitorHash" = :visitorHash', { visitorHash })
        .execute().catch(() => {});
      return 'exhausted';
    }
    return 'consumed';
  }

  /**
   * 分批清理过期会话（按 expiresAt 索引，上限 PRUNE_BATCH_LIMIT）。
   * 供请求路径低频触发与运维脚本共用；不做全表扫描。
   */
  async pruneExpired(limit = PRUNE_BATCH_LIMIT): Promise<number> {
    const sub = this.sessionRepo
      .createQueryBuilder()
      .select('id')
      .where('"expiresAt" < :now', { now: new Date() })
      .orderBy('"expiresAt"', 'ASC')
      .limit(limit)
      .getQuery();
    const result = await this.sessionRepo.query(
      `DELETE FROM "share_preview_sessions" WHERE "id" IN (${sub})`,
    );
    return Array.isArray(result) ? (result[1] as number) ?? 0 : 0;
  }
}

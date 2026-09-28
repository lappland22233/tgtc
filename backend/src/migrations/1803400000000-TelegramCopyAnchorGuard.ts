import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 副本锚点一致性（PostgreSQL）。
 *
 * ## 背景
 *
 * 「按负载挑一个账号回源」依赖 `(chatId, messageId)` 入站锚点能稳定解析到**唯一逻辑主键**。
 * 该锚点原先是普通索引（非唯一），因此同一账号在同一条消息上可以登记互相矛盾的
 * `file_unique_id`（重复登记 / 锚点串号）。一旦出现，`findByAnchor` 的候选集合就会在
 * 不同逻辑主键之间漂移，表现为「副本明明存在，却总压在同一账号」这类不可复现的分布异常。
 *
 * ## 约束设计（**关键**：为什么不是 (chatId, messageId) 唯一）
 *
 * 直接对 `(chatId, messageId)` 加唯一约束会打断两处**合法**行为：
 * 1. 同一备份群里多个 Bot 都会收到同一条消息，各自以自己的 `accountId` 登记
 *    **自己的** `file_id`（同一 `file_unique_id`、不同账号）——若锚点唯一，
 *    第二个 Bot 将永远登记失败，副本永远扩散不出去；
 * 2. 桥接双写：`bridgeInboundCopyToLogicalFile` 会把同一锚点额外写到 `file` 命名空间
 *    （`file_unique_id` 可能命中多条站内文件），同一锚点对应多个 `ownerId` 是设计内行为。
 *
 * 因此本迁移建立**按账号维度**的部分唯一索引：
 * `(chatId, messageId, accountId) WHERE ownerType='fileUnique' AND chatId/messageId 非空`。
 * 它精确挡住真正的脏数据来源，同时不影响任何合法写入。
 *
 * 跨账号的分歧（两个账号对同一消息给出不同 `file_unique_id`）无法用单索引表达，
 * 由 `FileCopyService.findByAnchor` 的确定性收敛 + `anchorConflicts` 计数暴露给审计。
 *
 * ## 顺序：先盘点、后加约束
 *
 * 存量库可能已有违反该约束的历史行。约束创建失败会让整条迁移链失败并阻断升级，
 * 因此先**只读盘点**：把冲突锚点数量、样例写入日志（**不打印完整 file_unique_id**），
 * 再尝试建索引。冲突行不会被自动改写或删除——副本行代表 Telegram 上真实存在的文件，
 * 属于业务数据，只能由运维按日志核对后人工处理。
 *
 * 索引本身是 expand 式增量（新增部分唯一索引），不改列、不删数据，旧版本代码
 * 仍可读写（仅少一层一致性保护），因此可安全回滚。
 */
export class TelegramCopyAnchorGuard1803400000000 implements MigrationInterface {
  name = 'TelegramCopyAnchorGuard1803400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    // 1) 只读盘点：同一账号在同一条入站消息上登记了多个逻辑主键的冲突数量
    const conflicts = await queryRunner.query(`
      SELECT COUNT(*)::int AS conflict_groups,
             COALESCE(SUM(dup_count), 0)::int AS conflict_rows
      FROM (
        SELECT "chatId", "messageId", "accountId", COUNT(*) AS dup_count
        FROM "telegram_file_copies"
        WHERE "ownerType" = 'fileUnique'
          AND "chatId" IS NOT NULL
          AND "messageId" IS NOT NULL
        GROUP BY "chatId", "messageId", "accountId"
        HAVING COUNT(*) > 1
      ) grouped
    `) as Array<{ conflict_groups: number; conflict_rows: number }>;
    const conflictGroups = Number(conflicts?.[0]?.conflict_groups ?? 0);
    const conflictRows = Number(conflicts?.[0]?.conflict_rows ?? 0);
    if (conflictGroups > 0) {
      // 只输出聚合值与脱敏样例（chatId/messageId/accountId 是运维需要定位的字段，
      // 不输出 telegramFileId / file_id，避免日志泄漏可下载句柄）
      const samples = await queryRunner.query(`
        SELECT "chatId", "messageId", "accountId", COUNT(*)::int AS dup_count
        FROM "telegram_file_copies"
        WHERE "ownerType" = 'fileUnique'
          AND "chatId" IS NOT NULL
          AND "messageId" IS NOT NULL
        GROUP BY "chatId", "messageId", "accountId"
        HAVING COUNT(*) > 1
        ORDER BY "chatId", "messageId", "accountId"
        LIMIT 20
      `) as Array<{ chatId: string; messageId: string; accountId: string; dup_count: number }>;
      console.warn(
        `[1803400000000] 检测到 ${conflictGroups} 组锚点冲突（共 ${conflictRows} 行）：`
        + '同一账号在同一条入站消息上登记了多个逻辑主键。'
        + '这些行不会被自动改写，请按下列样例核对后人工清理；'
        + '索引创建会在存在冲突时失败，因此需要先处理数据再重跑迁移。',
      );
      for (const row of samples) {
        console.warn(
          `[1803400000000] 冲突样例：chat=${row.chatId} message=${row.messageId} `
          + `account=${row.accountId} 行数=${row.dup_count}`,
        );
      }
    }

    // 2) 建索引（`CREATE UNIQUE INDEX IF NOT EXISTS` 保证重复执行幂等）
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_file_copies_anchor_account"
      ON "telegram_file_copies" ("chatId", "messageId", "accountId")
      WHERE "ownerType" = 'fileUnique'
        AND "chatId" IS NOT NULL
        AND "messageId" IS NOT NULL
    `);

    // 3) 覆盖查询用的辅助索引：按锚点+命名空间定位逻辑主键（findByAnchor 的多行读取路径）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tg_file_copies_anchor_owner"
      ON "telegram_file_copies" ("chatId", "messageId", "ownerType", "ownerId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    // 只删除本迁移新增的索引；不改数据、不动既有索引
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_file_copies_anchor_owner"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_file_copies_anchor_account"`);
  }
}

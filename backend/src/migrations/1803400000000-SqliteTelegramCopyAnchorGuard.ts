import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 副本锚点一致性（SQLite 独立基线链）。
 *
 * 与 `1803400000000-TelegramCopyAnchorGuard.ts` 同义，仅方言差异：
 * - SQLite 从 3.8.0 起支持部分索引（`CREATE INDEX ... WHERE ...`），
 *   这里与 PG 使用完全相同的谓词，保证两套方言的约束语义一致；
 * - 存量库可能缺表（旧基线未含副本表）：先用 `getTable` 判定，缺表则跳过
 *   （由基线按实体元数据建表时一并建立该索引，避免此处引用不存在的表）；
 * - 冲突盘点只读、只打日志，不自动改写业务数据。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被 SQLite 迁移 glob 加载。
 */
export class SqliteTelegramCopyAnchorGuard1803400000000 implements MigrationInterface {
  name = 'SqliteTelegramCopyAnchorGuard1803400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    const table = await queryRunner.getTable('telegram_file_copies');
    // 旧基线（尚未包含副本表）下无事可做：表与索引由基线/180290 增量补建
    if (!table) return;

    // 1) 只读盘点：同一账号在同一条入站消息上登记多个逻辑主键的冲突
    const conflicts = await queryRunner.query(`
      SELECT COUNT(*) AS conflict_groups,
             COALESCE(SUM(dup_count), 0) AS conflict_rows
      FROM (
        SELECT "chatId", "messageId", "accountId", COUNT(*) AS dup_count
        FROM "telegram_file_copies"
        WHERE "ownerType" = 'fileUnique'
          AND "chatId" IS NOT NULL
          AND "messageId" IS NOT NULL
        GROUP BY "chatId", "messageId", "accountId"
        HAVING COUNT(*) > 1
      ) grouped
    `) as Array<{ conflict_groups: number | string; conflict_rows: number | string }>;
    const conflictGroups = Number(conflicts?.[0]?.conflict_groups ?? 0);
    const conflictRows = Number(conflicts?.[0]?.conflict_rows ?? 0);
    if (conflictGroups > 0) {
      const samples = await queryRunner.query(`
        SELECT "chatId", "messageId", "accountId", COUNT(*) AS dup_count
        FROM "telegram_file_copies"
        WHERE "ownerType" = 'fileUnique'
          AND "chatId" IS NOT NULL
          AND "messageId" IS NOT NULL
        GROUP BY "chatId", "messageId", "accountId"
        HAVING COUNT(*) > 1
        ORDER BY "chatId", "messageId", "accountId"
        LIMIT 20
      `) as Array<{ chatId: string; messageId: string; accountId: string; dup_count: number | string }>;
      console.warn(
        `[Sqlite1803400000000] 检测到 ${conflictGroups} 组锚点冲突（共 ${conflictRows} 行）：`
        + '同一账号在同一条入站消息上登记了多个逻辑主键；'
        + '这些行不会被自动改写，索引创建会失败，请核对样例后人工清理再重跑。',
      );
      for (const row of samples) {
        console.warn(
          `[Sqlite1803400000000] 冲突样例：chat=${row.chatId} message=${row.messageId} `
          + `account=${row.accountId} 行数=${row.dup_count}`,
        );
      }
    }

    // 2) 部分唯一索引（谓词与 PG 迁移逐字一致）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_file_copies_anchor_account"`
      + ` ON "telegram_file_copies" ("chatId", "messageId", "accountId")`
      + ` WHERE "ownerType" = 'fileUnique' AND "chatId" IS NOT NULL AND "messageId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_file_copies_anchor_owner"`
      + ` ON "telegram_file_copies" ("chatId", "messageId", "ownerType", "ownerId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_file_copies_anchor_owner"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_file_copies_anchor_account"`);
  }
}

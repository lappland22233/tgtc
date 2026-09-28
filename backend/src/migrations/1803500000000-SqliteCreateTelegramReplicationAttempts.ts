import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 副本扩散轮次表（SQLite 独立基线链）。
 *
 * 与 `1803500000000-CreateTelegramReplicationAttempts.ts` 同义，仅方言差异：
 * - 全新库由 SQLite 基线（`SqliteEntitySchema`）按实体元数据建表；存量库基线已执行
 *   不会重跑，故此处在 `*-Sqlite*` 链中用 `CREATE TABLE IF NOT EXISTS` 幂等补齐；
 * - `jsonb` → `simple-json`（TypeORM 以 TEXT 存 JSON 文本）；
 * - `timestamptz` → `datetime`；时间默认值用 `datetime('now')`；
 * - uuid 主键在 SQLite 由 `UuidSubscriber` 应用层生成，主键列写 `varchar`。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被 SQLite 迁移 glob 加载。
 */
export class SqliteCreateTelegramReplicationAttempts1803500000000 implements MigrationInterface {
  name = 'SqliteCreateTelegramReplicationAttempts1803500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_replication_attempts" (
        "id" varchar PRIMARY KEY NOT NULL,
        "ownerType" varchar(16) NOT NULL,
        "ownerId" varchar(64) NOT NULL,
        "sourceAccountId" varchar(64),
        "targetChatId" varchar(32),
        "idempotencyKey" varchar(160),
        "desiredCount" int NOT NULL DEFAULT 0,
        "baselineReadyCount" int NOT NULL DEFAULT 0,
        "claimedAccountIds" text,
        "missingCount" int NOT NULL DEFAULT 0,
        "status" varchar(24) NOT NULL DEFAULT 'planned',
        "failureReason" varchar(32),
        "failureSummary" varchar(500),
        "retryCount" int NOT NULL DEFAULT 0,
        "relayAccountId" varchar(64),
        "relayMessageId" varchar(32),
        "startedAt" datetime,
        "relayCompletedAt" datetime,
        "claimDeadlineAt" datetime,
        "completedAt" datetime,
        "nextRetryAt" datetime,
        "triggeredBy" varchar(16) NOT NULL DEFAULT 'lazy',
        "operatorUserId" varchar(64),
        "retriedFromId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_replication_attempts_owner"`
      + ` ON "telegram_replication_attempts" ("ownerType", "ownerId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_replication_attempts_status"`
      + ` ON "telegram_replication_attempts" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_replication_attempts_reason"`
      + ` ON "telegram_replication_attempts" ("failureReason")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_replication_attempts_updated"`
      + ` ON "telegram_replication_attempts" ("updatedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_updated"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_reason"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_owner"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_replication_attempts"`);
  }
}

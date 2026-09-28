import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 副本扩散轮次表（PostgreSQL）。
 *
 * ## 背景
 *
 * 副本扩散只保留策略 B（用户账号服务端中继 → 各 Bot 入站认领）。原实现把每轮结果
 * 只留在 `logger.warn` 与进程内计数里，于是生产的核心问题——「副本没补齐，卡在哪一步、
 * 为什么、下一步做什么」——只能从账号池冷却日志反查。本表把每轮扩散落成可查询事实。
 *
 * ## 为什么是独立表而不是扩展 telegram_file_copies
 *
 * 副本表是「逻辑文件 → 账号 → file_id」的**当前状态**映射（`(ownerType,ownerId,accountId)`
 * 唯一），而轮次是**时间序列**：同一文件会经历多次 planned/blocked/relay/claim_timeout。
 * 塞进副本表会破坏其唯一约束语义，也会让副本清理逻辑误删审计证据。
 *
 * ## 设计要点
 *
 * - **不设 `bytesTransferred` 列**：策略 B 不发生文件字节二次传输，恒为 0；
 *   留一列反而会被误读为「有字节流动」；
 * - `claimedAccountIds` 用 `jsonb`（SQLite 侧为 simple-json）：只存账号内部 ID，不含凭据；
 * - `id` 为 UUID 主键并带库端默认值（`@PrimaryGeneratedColumn('uuid')` 在 PG 下不做
 *   应用层生成，漏写默认值会让整表写入 100% 报 23502）；
 * - 索引覆盖四类查询：按 owner 拉时间线、按状态筛选、按失败原因聚合、按更新时间清理；
 * - 不建外键：与账号体系解耦，便于按保留窗口独立清理。
 *
 * 采用 expand 式增量：只新增表与索引，不删改任何旧字段与旧路径，旧版本代码可继续运行。
 */
export class CreateTelegramReplicationAttempts1803500000000 implements MigrationInterface {
  name = 'CreateTelegramReplicationAttempts1803500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_replication_attempts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ownerType" varchar(16) NOT NULL,
        "ownerId" varchar(64) NOT NULL,
        "sourceAccountId" varchar(64),
        "targetChatId" varchar(32),
        "idempotencyKey" varchar(160),
        "desiredCount" int NOT NULL DEFAULT 0,
        "baselineReadyCount" int NOT NULL DEFAULT 0,
        "claimedAccountIds" jsonb,
        "missingCount" int NOT NULL DEFAULT 0,
        "status" varchar(24) NOT NULL DEFAULT 'planned',
        "failureReason" varchar(32),
        "failureSummary" varchar(500),
        "retryCount" int NOT NULL DEFAULT 0,
        "relayAccountId" varchar(64),
        "relayMessageId" varchar(32),
        "startedAt" timestamptz,
        "relayCompletedAt" timestamptz,
        "claimDeadlineAt" timestamptz,
        "completedAt" timestamptz,
        "nextRetryAt" timestamptz,
        "triggeredBy" varchar(16) NOT NULL DEFAULT 'lazy',
        "operatorUserId" varchar(64),
        "retriedFromId" uuid,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_replication_attempts_id" PRIMARY KEY ("id")
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
    if (queryRunner.connection.options.type !== 'postgres') return;
    // 轮次表是可审计证据：down 只在本迁移自身回滚时删除，生产禁止直接回滚破坏历史事件
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_updated"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_reason"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_replication_attempts_owner"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_replication_attempts"`);
  }
}

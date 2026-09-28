import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 镜像备份规则与镜像任务表（PostgreSQL）。
 *
 * 为什么必须持久化任务：镜像要能重试、能在进程重启后恢复、能在失败时被管理员
 * 看见并手动重试；进程内 Map 会在重启后静默丢失，产生「主文件成功但备份永远
 * 缺失且无人知晓」。
 *
 * 幂等键 = `(ruleId, ownerType, ownerId, sourceVersion)` 唯一索引：
 * - 重复事件、Bull 重试、进程重启都收敛到同一条任务记录；
 * - `sourceVersion` 绑定 `File.uploadVersion`，覆盖上传后旧任务必然失配，
 *   不会把旧内容写进备份群。
 *
 * 采用 expand 式增量：只新增表与索引，不删改任何旧字段与旧路径。
 */
export class CreateTelegramMirror1803100000000 implements MigrationInterface {
  name = 'CreateTelegramMirror1803100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_mirror_rules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "enabled" boolean NOT NULL DEFAULT false,
        "name" varchar(64) NOT NULL,
        "sourceChatId" varchar(32) NOT NULL,
        "targetChatId" varchar(32) NOT NULL,
        "mode" varchar(16) NOT NULL DEFAULT 'bot_upload',
        "preferredAccountId" varchar(64),
        "fallbackMode" varchar(16) NOT NULL DEFAULT 'disabled',
        "includeWebUploads" boolean NOT NULL DEFAULT true,
        "includeBotInboundFiles" boolean NOT NULL DEFAULT false,
        "lastTestedAt" timestamptz,
        "lastTestStatus" varchar(16) NOT NULL DEFAULT 'untested',
        "lastTestSummary" varchar(500),
        "createdBy" varchar(64),
        "updatedBy" varchar(64),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_mirror_rules_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_rules_enabled"`
      + ` ON "telegram_mirror_rules" ("enabled")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_mirror_tasks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ruleId" uuid NOT NULL,
        "ownerType" varchar(16) NOT NULL,
        "ownerId" varchar(64) NOT NULL,
        "sourceVersion" int NOT NULL DEFAULT 1,
        "sourceAccountId" varchar(64),
        "sourceChatId" varchar(32),
        "sourceMessageId" varchar(32),
        "targetAccountId" varchar(64),
        "mode" varchar(16) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'queued',
        "attempts" int NOT NULL DEFAULT 0,
        "targetMessageId" varchar(32),
        "targetTelegramFileId" varchar(512),
        "targetChatId" varchar(32),
        "receiptPending" boolean NOT NULL DEFAULT false,
        "lastErrorCode" varchar(64),
        "lastErrorSummary" varchar(500),
        "nextRetryAt" timestamptz,
        "startedAt" timestamptz,
        "completedAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_mirror_tasks_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_mirror_tasks_idempotency"`
      + ` ON "telegram_mirror_tasks" ("ruleId", "ownerType", "ownerId", "sourceVersion")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_tasks_status"`
      + ` ON "telegram_mirror_tasks" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_tasks_rule_status"`
      + ` ON "telegram_mirror_tasks" ("ruleId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_mirror_tasks_next_retry"`
      + ` ON "telegram_mirror_tasks" ("nextRetryAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_tasks_next_retry"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_tasks_rule_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_tasks_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_mirror_tasks_idempotency"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_mirror_tasks"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_mirror_rules_enabled"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_mirror_rules"`);
  }
}

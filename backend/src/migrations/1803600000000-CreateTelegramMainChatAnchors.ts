import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 主群锚点表（PostgreSQL）。
 *
 * ## 背景
 *
 * 副本扩散链路收敛为唯一形态：**持有源消息的 Bot 先把消息转发进主群 → 用户账号(userbot)
 * 从主群服务端转发到各镜像群**。用户账号读不到「Bot 与用户的私聊」，也未必是各账号存储
 * Chat 的成员，因此源锚点必须先落到主群才能被中继。
 *
 * ## 为什么必须独立成表
 *
 * Bot API 的 `forwardMessage` **没有幂等键**——重试会再搬一次并在主群留下重复消息。
 * 因此搬运结果必须先落库再重试；而落点必须**在所有镜像规则之间共享**：一条规则一行任务，
 * 若把锚点写在各任务行上，同一文件会被搬运 N 次。
 *
 * ## 设计要点
 *
 * - `(ownerType, ownerId)` 唯一：同一逻辑归属对象在主群只有一个落点；
 * - `anchorMessageId` 可空：搬运失败时写 `status='failed'` 与 `lastError`，供运维定位；
 * - **不设 `bytesTransferred` 列**：本链路只做服务端转发，字节二次传输恒为 0；
 * - `id` 为 UUID 主键并带库端默认值（`@PrimaryGeneratedColumn('uuid')` 在 PG 下不做
 *   应用层生成，漏写默认值会让整表写入 100% 报 23502）；
 * - 不建外键：与站内文件/授权体系解耦，便于按归属对象独立清理。
 *
 * 采用 expand 式增量：只新增表与索引，不删改任何旧字段与旧路径，旧版本代码可继续运行。
 */
export class CreateTelegramMainChatAnchors1803600000000 implements MigrationInterface {
  name = 'CreateTelegramMainChatAnchors1803600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_main_chat_anchors" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ownerType" varchar(16) NOT NULL,
        "ownerId" varchar(64) NOT NULL,
        "anchorChatId" varchar(32) NOT NULL,
        "anchorMessageId" varchar(32),
        "plantedByAccountId" varchar(64),
        "sourceChatId" varchar(32),
        "sourceMessageId" varchar(32),
        "status" varchar(16) NOT NULL DEFAULT 'ready',
        "lastError" varchar(500),
        "plantedAt" timestamptz,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_main_chat_anchors_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tg_main_chat_anchors_owner"`
      + ` ON "telegram_main_chat_anchors" ("ownerType", "ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_main_chat_anchors_anchor"`
      + ` ON "telegram_main_chat_anchors" ("anchorChatId", "anchorMessageId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    // 锚点行指向 Telegram 上真实存在的消息，是可审计证据：down 只在本迁移自身回滚时删除
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_main_chat_anchors_anchor"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_tg_main_chat_anchors_owner"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_main_chat_anchors"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `telegram_bot_file_grants` 表新增 `fileUniqueId` 列与索引（SQLite 方言）。
 *
 * 与 PG 侧同名迁移语义一致：镜像群/主群里的消息只携带 `file_unique_id`，
 * 用它把「群内认领」归因回 grant，扩散轮次才能结算（否则恒为 `claim_timeout`）。
 *
 * 全新库由 SQLite 基线按实体元数据建表；存量库基线已执行不会重跑，故此处用
 * `getTable` 判定后补齐（SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，
 * 与 180230/180260/180290/180320 一致）；索引用 `CREATE INDEX IF NOT EXISTS` 幂等创建。
 *
 * 全部可空、历史数据保持 NULL：不写该列不影响既有直链链路。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被正式 SQLite 迁移 glob 加载。
 */
export class SqliteAddGrantFileUniqueId1803700000000 implements MigrationInterface {
  name = 'SqliteAddGrantFileUniqueId1803700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    const table = await queryRunner.getTable('telegram_bot_file_grants');
    if (!table) return;

    if (!table.columns.some((column) => column.name === 'fileUniqueId')) {
      await queryRunner.query(
        `ALTER TABLE "telegram_bot_file_grants" ADD COLUMN "fileUniqueId" varchar(128)`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tg_bot_grants_fileUniqueId"`
      + ` ON "telegram_bot_file_grants" ("fileUniqueId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    // SQLite 旧版本不支持 DROP COLUMN；保留可空列无数据风险，与既有迁移（180320）保持一致。
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tg_bot_grants_fileUniqueId"`);
  }
}

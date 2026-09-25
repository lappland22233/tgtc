import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `files.telegramFileUniqueId` 建索引（SQLite 方言）。
 *
 * 与 PG 侧同名迁移语义一致：入站副本桥接按 `file_unique_id` 反查站内逻辑文件，
 * 该查询在每条群内文件消息上触发，需要索引避免全表扫描。
 *
 * 为什么仍然要显式建：全新 SQLite 库的表结构由基线迁移按实体元数据建立，而
 * `File` 实体未声明该索引；存量库的表更是早已建好。两种情况都靠本迁移补齐。
 * SQLite 支持 `CREATE INDEX IF NOT EXISTS`，天然幂等。
 *
 * 注意：本文件必须带 `-Sqlite` 后缀，否则不会被正式 SQLite 迁移 glob 加载。
 */
export class SqliteAddFileTelegramUniqueIdIndex1803300000000 implements MigrationInterface {
  name = 'SqliteAddFileTelegramUniqueIdIndex1803300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;

    const table = await queryRunner.getTable('files');
    if (!table) return;
    if (table.indices.some((index) => index.name === 'idx_files_telegram_file_unique_id')) return;

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_files_telegram_file_unique_id"`
      + ` ON "files" ("telegramFileUniqueId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'sqlite') return;
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_telegram_file_unique_id"`);
  }
}

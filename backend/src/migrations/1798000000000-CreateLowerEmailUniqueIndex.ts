import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G6-12：用户邮箱大小写不敏感唯一。
 *
 * 背景：
 * - 原 `users.email` 唯一约束大小写敏感（'A@x.com' 与 'a@x.com' 视为不同邮箱），
 *   但服务层登录/注册已将邮箱归一化为小写，仍可能残留大小写变体存量数据。
 * - 本迁移：
 *   1. 将存量 email 统一为小写（lowercase 回填）；
 *   2. 处理小写化后可能产生的冲突（同 lower(email) 重复行）：保留最早注册的一行，
 *      其余重复行的 email 追加不可邮箱格式的后缀以维持行唯一（并显著标注，供后续人工清理）；
 *   3. 删除旧的、大小写敏感的单列唯一约束；
 *   4. 创建 UNIQUE(lower(email)) 函数索引，使邮箱大小写不敏感唯一。
 *
 * 风险与演练要求：
 * - 若存量库存在大量大小写变体冲突，步骤 2 的「追加后缀」属于数据改写，
 *   需先在测试库演练，确认重复行数量与处理结果符合预期后再上生产。
 * - 向下迁移仅 DROP 函数索引并重建普通唯一约束（不还原已被改写的 email）。
 */
export class CreateLowerEmailUniqueIndex1798000000000 implements MigrationInterface {
  name = 'CreateLowerEmailUniqueIndex1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 探测并报告存量大小写冲突（小写化后会撞唯一键的行），供演练核对
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS _g612_email_conflicts AS
       SELECT lower(email) AS email, COUNT(*) AS cnt
       FROM "users"
       GROUP BY lower(email)
       HAVING COUNT(*) > 1`,
    );

    // 2. 处理冲突：对小写化后重复的行，保留最早注册的一行（createdAt 最小，并列时取 id 最小），
    //    其余行 email 追加不可用后缀以保持唯一（避免建索引失败）。
    //    注意：不得用 MIN(u3.id)——UUID 字典序与注册时间无关，会保留错误的"主账号"。
    await queryRunner.query(`
      UPDATE "users" u
      SET email = lower(u.email) || '+duplicate-' || replace(u.id::text, '-', '')
      WHERE u.id IN (
        SELECT u2.id FROM "users" u2
        JOIN _g612_email_conflicts c ON lower(u2.email) = c.email
        WHERE u2.id NOT IN (
          SELECT u3.id FROM "users" u3
          WHERE lower(u3.email) = c.email
          ORDER BY "createdAt" ASC, u3.id ASC
          LIMIT 1
        )
      )
    `);

    // 3. 存量 email 统一小写
    await queryRunner.query(`UPDATE "users" SET email = lower(email)`);

    // 4. 删除旧的大小写敏感唯一约束（动态查找 UQ_% 且定义含 email 的约束）
    await queryRunner.query(`
      DO $$
      DECLARE
        con_name text;
      BEGIN
        SELECT conname INTO con_name
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND contype = 'u'
          AND conname LIKE 'UQ_%'
          AND pg_get_constraintdef(oid) LIKE '%"email"%'
        LIMIT 1;
        IF con_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE "users" DROP CONSTRAINT "%s"', con_name);
        END IF;
      END $$;
    `);

    // 5. 创建大小写不敏感唯一函数索引
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_email_lower" ON "users" (lower("email"))`,
    );

    // 清理临时冲突表
    await queryRunner.query(`DROP TABLE IF EXISTS _g612_email_conflicts`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_email_lower"`);
    // 重建普通唯一约束（注意：不还原已被改写的 email 大小写/后缀）
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "UQ_users_email" UNIQUE ("email")`,
    );
  }
}

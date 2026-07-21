import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 管理后台 / 告警 / 遥测模块的 schema 修复（配合静态审查修复）。
 *
 * 内容：
 *  1. alerts：补充未确认告警查询所需的部分索引（按 createdAt，WHERE acknowledgedAt IS NULL）。
 *     （IDX_alerts_acknowledged 已由 1785000000000 创建，此处仅幂等确保存在。）
 *  2. telemetry_records：以 (type, "createdAt") 复合索引取代冗余的 type 单列索引；
 *     新增 ip 索引以服务 COUNT(DISTINCT ip)。
 *  3. audit_logs：metadata 由 json 升级为 jsonb（读时免重解析、可 GIN 索引）。
 *  4. access_logs：新增 ("createdAt", ip) 与 ("createdAt", "statusCode") 复合索引。
 *  5. dashboard_configs：config 列默认值由 '{}' 改为 '[]'（实际作为数组使用）。
 *
 * 全部语句幂等（IF NOT EXISTS / IF EXISTS），对已是目标状态的库无副作用。
 */
export class AdminAlertFixes1790700200000 implements MigrationInterface {
  name = 'AdminAlertFixes1790700200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. alerts：未确认告警部分索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_alerts_acknowledged"
       ON "alerts" ("acknowledgedAt") WHERE "acknowledgedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_alerts_unacknowledged_createdAt"
       ON "alerts" ("createdAt") WHERE "acknowledgedAt" IS NULL`,
    );

    // 2. telemetry_records：复合索引 + ip 索引，移除冗余 type 单列索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_type_createdAt"
       ON "telemetry_records" ("type", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_ip"
       ON "telemetry_records" ("ip")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_type"`);

    // 3. audit_logs：metadata json → jsonb
    const auditCols = await queryRunner.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'audit_logs' AND column_name = 'metadata'
    `);
    if (auditCols.length > 0 && auditCols[0].data_type !== 'jsonb') {
      await queryRunner.query(
        `ALTER TABLE "audit_logs"
         ALTER COLUMN "metadata" TYPE jsonb USING "metadata"::jsonb`,
      );
    }

    // 4. access_logs：复合索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_createdAt_ip"
       ON "access_logs" ("createdAt", "ip")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_access_logs_createdAt_statusCode"
       ON "access_logs" ("createdAt", "statusCode")`,
    );

    // 5. dashboard_configs：config 默认值改为空数组
    const dashCols = await queryRunner.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'dashboard_configs' AND column_name = 'config'
    `);
    if (dashCols.length > 0) {
      await queryRunner.query(
        `ALTER TABLE "dashboard_configs" ALTER COLUMN "config" SET DEFAULT '[]'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 5. dashboard_configs：恢复默认值
    const dashCols = await queryRunner.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'dashboard_configs' AND column_name = 'config'
    `);
    if (dashCols.length > 0) {
      await queryRunner.query(
        `ALTER TABLE "dashboard_configs" ALTER COLUMN "config" SET DEFAULT '{}'`,
      );
    }

    // 4. access_logs：删除复合索引
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_createdAt_statusCode"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_createdAt_ip"`);

    // 3. audit_logs：jsonb → json
    const auditCols = await queryRunner.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'audit_logs' AND column_name = 'metadata'
    `);
    if (auditCols.length > 0 && auditCols[0].data_type === 'jsonb') {
      await queryRunner.query(
        `ALTER TABLE "audit_logs"
         ALTER COLUMN "metadata" TYPE json USING "metadata"::text::json`,
      );
    }

    // 2. telemetry_records：恢复 type 单列索引，删除复合/ip 索引
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_telemetry_records_type"
       ON "telemetry_records" ("type")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_ip"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_telemetry_records_type_createdAt"`);

    // 1. alerts：仅删除本迁移新增的部分索引
    //    （IDX_alerts_acknowledged 由 1785000000000 创建，不在此回滚）
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_alerts_unacknowledged_createdAt"`);
  }
}

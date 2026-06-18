import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPerformanceIndexes1783000000000 implements MigrationInterface {
    name = 'AddPerformanceIndexes1783000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // T6-2: verification_codes — 加速验证码查询 (email + type + isUsed)
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_verification_codes_email_type_isUsed" ON "verification_codes" ("email", "type", "isUsed")`);
        // T6-4: audit_logs — 加速按 userId/action/time 筛选
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_userId" ON "audit_logs" ("userId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt" ON "audit_logs" ("createdAt")`);
        // T6-3: access_logs — 加速统计查询
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_access_logs_createdAt" ON "access_logs" ("createdAt")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_access_logs_path" ON "access_logs" ("path")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_access_logs_statusCode" ON "access_logs" ("statusCode")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_statusCode"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_path"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_access_logs_createdAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_createdAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_action"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_userId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_verification_codes_email_type_isUsed"`);
    }

}

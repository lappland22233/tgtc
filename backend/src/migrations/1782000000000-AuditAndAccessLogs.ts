import { MigrationInterface, QueryRunner } from "typeorm";

export class AuditAndAccessLogs1782000000000 implements MigrationInterface {
    name = 'AuditAndAccessLogs1782000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "audit_logs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" character varying,
                "action" character varying(50) NOT NULL,
                "ip" character varying,
                "resourceType" character varying,
                "resourceId" character varying,
                "metadata" json,
                "status" character varying(20) NOT NULL DEFAULT 'success',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."userId" IS '操作者ID，匿名操作可为空'`);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."action" IS '操作类型'`);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."ip" IS '操作IP'`);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."resourceType" IS '资源类型'`);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."resourceId" IS '资源ID'`);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."metadata" IS '元数据JSON（如变更前后值、失败原因等）'`);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."status" IS '操作状态：success / failure'`);
        await queryRunner.query(`COMMENT ON COLUMN "audit_logs"."createdAt" IS '创建时间'`);

        await queryRunner.query(`
            CREATE TABLE "access_logs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "ip" character varying NOT NULL,
                "method" character varying(10) NOT NULL,
                "path" character varying(500) NOT NULL,
                "statusCode" integer NOT NULL,
                "responseSize" bigint NOT NULL DEFAULT '0',
                "duration" integer NOT NULL DEFAULT '0',
                "userAgent" character varying(500),
                "referer" character varying(300),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_access_logs_id" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."ip" IS '客户端 IP 地址'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."method" IS 'HTTP 方法'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."path" IS '请求路径'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."statusCode" IS 'HTTP 状态码'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."responseSize" IS '响应体大小（字节），用于带宽统计'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."duration" IS '请求耗时（毫秒）'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."userAgent" IS 'User-Agent'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."referer" IS 'Referer'`);
        await queryRunner.query(`COMMENT ON COLUMN "access_logs"."createdAt" IS '请求时间'`);

        await queryRunner.query(`CREATE INDEX "idx_access_logs_ip" ON "access_logs" ("ip")`);
        await queryRunner.query(`CREATE INDEX "idx_access_logs_createdAt" ON "access_logs" ("createdAt")`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_createdAt" ON "audit_logs" ("createdAt")`);
        await queryRunner.query(`CREATE INDEX "idx_audit_logs_action" ON "audit_logs" ("action")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "access_logs"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
    }
}

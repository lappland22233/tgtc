import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1704300000000 implements MigrationInterface {
  name = 'InitialSchema1704300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // users 表
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "email" varchar NOT NULL UNIQUE,
        "password" varchar NOT NULL,
        "role" varchar NOT NULL DEFAULT 'user',
        "emailVerified" boolean NOT NULL DEFAULT false,
        "isBanned" boolean NOT NULL DEFAULT false,
        "lastLoginIP" varchar,
        "lastLoginAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    // files 表
    await queryRunner.query(`
      CREATE TABLE "files" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "filename" varchar NOT NULL,
        "originalName" varchar NOT NULL,
        "mimeType" varchar NOT NULL,
        "size" bigint NOT NULL,
        "telegramFileId" varchar NOT NULL,
        "telegramFilePath" varchar NOT NULL,
        "accessType" varchar NOT NULL DEFAULT 'public',
        "maxAccessCount" integer NOT NULL DEFAULT -1,
        "currentAccessCount" integer NOT NULL DEFAULT 0,
        "password" varchar,
        "isDeleted" boolean NOT NULL DEFAULT false,
        "uploaderId" uuid NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "fk_files_uploader" FOREIGN KEY ("uploaderId") REFERENCES "users"("id")
      )
    `);

    // system_configs 表
    await queryRunner.query(`
      CREATE TABLE "system_configs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "key" varchar NOT NULL UNIQUE,
        "value" varchar NOT NULL,
        "description" varchar,
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    // verification_codes 表
    await queryRunner.query(`
      CREATE TABLE "verification_codes" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "email" varchar NOT NULL,
        "code" varchar NOT NULL,
        "type" varchar NOT NULL,
        "isUsed" boolean NOT NULL DEFAULT false,
        "expiresAt" timestamp NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    // banned_ips 表
    await queryRunner.query(`
      CREATE TABLE "banned_ips" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "ip" varchar NOT NULL UNIQUE,
        "reason" varchar,
        "isPermanent" boolean NOT NULL DEFAULT false,
        "bannedAt" timestamp NOT NULL DEFAULT now(),
        "unbannedAt" timestamp
      )
    `);

    // share_audits 表
    await queryRunner.query(`
      CREATE TABLE "share_audits" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "jti" varchar NOT NULL,
        "fileId" uuid NOT NULL,
        "userId" varchar NOT NULL DEFAULT '',
        "action" varchar NOT NULL,
        "ip" varchar NOT NULL DEFAULT '',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "fk_share_audits_file" FOREIGN KEY ("fileId") REFERENCES "files"("id")
      )
    `);

    // file_access_logs 表
    await queryRunner.query(`
      CREATE TABLE "file_access_logs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "fileId" uuid NOT NULL,
        "ip" varchar NOT NULL DEFAULT '',
        "action" varchar NOT NULL,
        "uploaderId" varchar NOT NULL DEFAULT '',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "fk_file_access_logs_file" FOREIGN KEY ("fileId") REFERENCES "files"("id")
      )
    `);

    // 索引
    await queryRunner.query(`CREATE INDEX "idx_files_uploaderId" ON "files"("uploaderId")`);
    await queryRunner.query(`CREATE INDEX "idx_verification_codes_email_type" ON "verification_codes"("email", "type")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "file_access_logs"`);
    await queryRunner.query(`DROP TABLE "share_audits"`);
    await queryRunner.query(`DROP TABLE "banned_ips"`);
    await queryRunner.query(`DROP TABLE "verification_codes"`);
    await queryRunner.query(`DROP TABLE "system_configs"`);
    await queryRunner.query(`DROP TABLE "files"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}

import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1780395032697 implements MigrationInterface {
    name = 'Migration1780395032697'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "files" ADD "expiresIn" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "files" DROP COLUMN "expiresIn"`);
    }

}

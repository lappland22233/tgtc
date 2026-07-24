import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddJwtRevokedTokens1790700500000 implements MigrationInterface {
  name = 'AddJwtRevokedTokens1790700500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(new Table({
      name: 'jwt_revoked_tokens',
      columns: [
        { name: 'jti', type: 'varchar', length: '64', isPrimary: true },
        { name: 'expiresAt', type: 'timestamp' },
        { name: 'revokedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
      ],
    }));
    await queryRunner.createIndex('jwt_revoked_tokens', new TableIndex({
      name: 'IDX_jwt_revoked_tokens_expiresAt',
      columnNames: ['expiresAt'],
    }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('jwt_revoked_tokens');
  }
}

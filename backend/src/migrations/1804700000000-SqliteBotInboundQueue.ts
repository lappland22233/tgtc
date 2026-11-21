import { MigrationInterface, QueryRunner } from 'typeorm';
import { createBotInboundQueue } from './bot-inbound-queue-schema';

export class SqliteBotInboundQueue1804700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'better-sqlite3') return;
    await createBotInboundQueue(runner, true);
    // SQLite TEXT affinity already stores full administrator UUIDs in revokedBy.
  }

  async down(): Promise<void> {
    // Preserve the exact task and ban state on migration replay.
  }
}

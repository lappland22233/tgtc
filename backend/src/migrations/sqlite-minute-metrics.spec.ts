import { DataSource } from 'typeorm';
import { sqliteDateParameter } from '../database/database-types';
import { SqliteCreateMinuteMetrics1804600000000 } from './1804600000000-SqliteCreateMinuteMetrics';

it('normalizes converted UTC timestamps and preserves the canonical aggregate on a key collision', async () => {
  const db = await new DataSource({ type: 'better-sqlite3', database: ':memory:' }).initialize();
  const runner = db.createQueryRunner();
  try {
    const migration = new SqliteCreateMinuteMetrics1804600000000();
    await runner.query('CREATE TABLE access_logs (id INTEGER PRIMARY KEY, "createdAt" datetime)');
    await migration.up(runner);
    await runner.query('INSERT INTO access_logs VALUES (1, ?), (2, ?)', [
      '2026-11-20T16:00:00.123Z', '2026-11-20 16:00:01.005',
    ]);
    await runner.query(`INSERT INTO access_log_metrics_1min ("windowTime", "totalRequests")
      VALUES (?, 1), (?, 2), (?, 3)`, [
      '2026-11-20T16:00:00.000Z', '2026-11-20 16:00:00.000', '2026-11-20T16:01:00.000Z',
    ]);
    await migration.up(runner);
    await migration.up(runner);
    const start = sqliteDateParameter(new Date('2026-11-21T00:00:00.123+08:00'));
    expect(start).toBe('2026-11-20 16:00:00.123');
    expect(await runner.query('SELECT id, "createdAt" FROM access_logs WHERE "createdAt" >= ? AND "createdAt" < ? ORDER BY id',
      [start, '2026-11-20 16:01:00.000'])).toEqual([
      { id: 1, createdAt: start }, { id: 2, createdAt: '2026-11-20 16:00:01.005' },
    ]);
    expect(await runner.query('SELECT "windowTime", "totalRequests" FROM access_log_metrics_1min ORDER BY "windowTime"')).toEqual([
      { windowTime: '2026-11-20 16:00:00.000', totalRequests: 2 },
      { windowTime: '2026-11-20 16:01:00.000', totalRequests: 3 },
    ]);
  } finally {
    await runner.release();
    await db.destroy();
  }
});

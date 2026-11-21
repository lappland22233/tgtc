import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DataSource, DataSourceOptions } from 'typeorm';
import type { GDriveOAuthStore } from './gdrive-oauth-store.service';

describe.each(['sqlite', ...(process.env.PG_API_KEY_IT === '1' ? ['postgres'] : [])])('GDrive OAuth persistence on %s', dialect => {
  let db: DataSource;
  let store: GDriveOAuthStore;
  let priorDialect: string | undefined;
  let sqliteDir: string | undefined;
  const schema = 'oauth_regression_' + process.pid + '_' + Date.now();

  beforeAll(async () => {
    priorDialect = process.env.DB_TYPE;
    process.env.DB_TYPE = dialect;
    const { DataSource } = await import('typeorm');
    const { GDriveOAuthFlow } = await import('../common/entities/gdrive-oauth-flow.entity');
    const { StorageBackend } = await import('../common/entities/storage-backend.entity');
    const { SystemConfig } = await import('../common/entities/system-config.entity');
    const entities = [GDriveOAuthFlow, StorageBackend, SystemConfig];
    if (dialect === 'sqlite') sqliteDir = mkdtempSync(join(tmpdir(), 'tgtc-gdrive-store-'));
    const options: DataSourceOptions = dialect === 'sqlite'
      ? { type: 'sqlite', database: join(sqliteDir!, 'oauth.sqlite'), entities, synchronize: true }
      : { type: 'postgres', host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
          database: process.env.DB_DATABASE, username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD,
          entities, schema, synchronize: false };
    db = new DataSource(options);
    await db.initialize();
    if (dialect === 'postgres') {
      await db.query('CREATE SCHEMA "' + schema + '"');
      await db.synchronize();
    }
    const { GDriveOAuthStore } = await import('./gdrive-oauth-store.service');
    store = new GDriveOAuthStore(db);
  });

  afterAll(async () => {
    await store?.onModuleDestroy();
    if (db?.isInitialized) {
      if (dialect === 'postgres') await db.query('DROP SCHEMA "' + schema + '" CASCADE');
      await db.destroy();
    }
    if (sqliteDir) rmSync(sqliteDir, { recursive: true, force: true });
    if (priorDialect === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = priorDialect;
    jest.resetModules();
  });

  it('prevents stale, mismatched and duplicate consumption across store instances', async () => {
    const { GDriveOAuthFlow } = await import('../common/entities/gdrive-oauth-flow.entity');
    const { GDriveOAuthStore } = await import('./gdrive-oauth-store.service');
    const other = new GDriveOAuthStore(db);
    const state = await store.issue('session-A');
    await expect(other.consume(state, 'session-B')).rejects.toThrow('授权状态');
    const attempts = await Promise.allSettled([store.consume(state, 'session-A'), other.consume(state, 'session-A')]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const expired = await store.issue('session-A');
    await db.createQueryBuilder().update(GDriveOAuthFlow).set({expiresAt: 1}).execute();
    await expect(store.consume(expired, 'session-A')).rejects.toThrow('授权状态');
    await other.onModuleDestroy();
  });

  it('keeps completed consumption committed when an unrelated application transaction rolls back', async () => {
    const state = await store.issue('session');
    await expect(db.transaction(async () => {
      await store.consume(state, 'session');
      throw new Error('unrelated rollback');
    })).rejects.toThrow('unrelated rollback');
    await expect(store.consume(state, 'session')).rejects.toThrow('授权状态');
  });

  it('keeps credentials paired and rechecks pending account writes against the current settings', async () => {
    const { StorageBackend } = await import('../common/entities/storage-backend.entity');
    await store.writeSettings('first', 'first-secret', 'https://example.invalid/old');
    await expect(store.writeSettings('second')).rejects.toThrow('client_secret');
    const before = await store.settings();
    expect(before).toMatchObject({clientId: 'first', secretCipher: 'first-secret'});
    await store.writeSettings('first', undefined, '');
    expect(await store.settings()).toMatchObject({secretCipher: 'first-secret', redirectUri: null});
    const row = db.manager.create(StorageBackend, {
      type: 'gdrive', name: 'disabled-account', status: 'disabled', credentialCiphertext: 'saved',
    });
    const saved = await store.saveAccount(row, before.revision);
    await expect(store.writeSettings('second', 'second-secret')).rejects.toThrow('请先撤销');
    await expect(store.writeSettings('')).rejects.toThrow('请先撤销');
    await store.writeSettings('first', 'rotated-secret');
    expect((await store.settings()).secretCipher).toBe('rotated-secret');
    await db.manager.update(StorageBackend, saved.id, {status: 'revoked', credentialCiphertext: null});
    await store.writeSettings('second', 'second-secret');
    await expect(store.saveAccount(row, before.revision)).rejects.toThrow('配置已变更');
    await store.writeSettings('');
    expect(await store.settings()).toMatchObject({ clientId: '', secretCipher: '' });
  });

  it('serializes an app change racing with the first account save', async () => {
    const { StorageBackend } = await import('../common/entities/storage-backend.entity');
    await store.writeSettings('first', 'first-secret');
    const { revision } = await store.settings();
    const row = db.manager.create(StorageBackend, {
      type: 'gdrive', name: 'race', status: 'active', credentialCiphertext: 'saved',
    });
    const [enroll, replace] = await Promise.allSettled([
      store.saveAccount(row, revision),
      store.writeSettings('other-app', 'other-secret'),
    ]);
    expect([enroll, replace].filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const count = await db.manager.countBy(StorageBackend, {name: 'race'});
    expect(await store.settings()).toMatchObject({clientId: count === 1 ? 'first' : 'other-app'});
  });
});

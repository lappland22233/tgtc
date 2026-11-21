import Bull from 'bull';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import type { File } from '../common/entities/file.entity';
import type { FileUploadProcessor } from './file-upload.processor';
import type { TasksService } from '../tasks/tasks.service';
import { pendingUploadName } from '../file/pending-upload';

const describeRedis = process.env.REDIS_IT === '1' ? describe : describe.skip;

describeRedis('真实 Redis 上传恢复与并发准入', () => {
  const originalDbType = process.env.DB_TYPE;
  const userId = randomUUID();
  let db: DataSource;
  let files: Repository<File>;
  let dir: string;
  let queue: Bull.Queue;
  let worker: Promise<void> | undefined;
  let processor: FileUploadProcessor;
  let tasks: TasksService;
  const upload = jest.fn(async () => ({ accountId: 'cloud', objectRef: 'receipt-object', size: 1 }));
  const uploadToTelegram = jest.fn();

  beforeAll(async () => {
    process.env.DB_TYPE = 'sqlite';
    // Entity column decorators use the selected dialect when the modules are loaded.
    const { createDatabaseOptions } = jest.requireActual<typeof import('../database/database.config')>('../database/database.config');
    const options = createDatabaseOptions({ ...process.env, DB_DATABASE: ':memory:' });
    db = await new DataSource({ ...options, migrationsRun: false, synchronize: true }).initialize();
    await db.getRepository('User').insert({ id: userId, email: 'queue-test@example.invalid', password: 'unused' });
    files = db.getRepository<File>('File');
    dir = await mkdtemp(join(tmpdir(), 'tgtc-upload-queue-'));
  }, 30000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (originalDbType === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = originalDbType;
  });

  beforeEach(async () => {
    upload.mockClear();
    uploadToTelegram.mockClear();
    queue = new Bull(`upload-recovery-${randomUUID()}`, {
      prefix: 'tgtc-ci',
      redis: {
        host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined, db: Number(process.env.REDIS_TEST_DB || 15),
        maxRetriesPerRequest: 1,
      },
    });
    await queue.isReady();
    const { AccountUploadUnavailableError } = jest.requireActual<typeof import('../telegram-account-pool/account-aware-upload.service')>('../telegram-account-pool/account-aware-upload.service');
    const { FileUploadProcessor } = jest.requireActual<typeof import('./file-upload.processor')>('./file-upload.processor');
    const { TasksService } = jest.requireActual<typeof import('../tasks/tasks.service')>('../tasks/tasks.service');
    processor = new FileUploadProcessor(
      files, { uploadFile: uploadToTelegram } as never, {} as never, undefined,
      {
        isActive: () => true,
        upload: async () => { throw new AccountUploadUnavailableError(true, 60_000); },
      } as never,
      { upload, isGDriveCacheModeEnabled: async () => false } as never,
    );
    tasks = new TasksService(undefined!, undefined!, undefined!, undefined!, undefined!, files, queue);
    worker = undefined;
  });

  afterEach(async () => {
    if (!queue) return;
    try { await queue.obliterate({ force: true }); } finally { await queue.close(); }
    await worker;
  });

  async function makePayload(backend: 'telegram' | 's3') {
    const fileId = randomUUID();
    const uploadVersion = 1;
    const filePath = join(dir, pendingUploadName(fileId, uploadVersion));
    await writeFile(filePath, 'a');
    await files.insert({
      id: fileId, uploaderId: userId, filename: 'a', originalName: 'a', size: 1,
      mimeType: 'application/octet-stream', telegramFileId: '', storageBackend: backend,
      status: 'processing', uploadStage: 'pending', uploadVersion,
    });
    return { fileId, filePath, uploadVersion };
  }

  it('保留的 failed 作业凭已落盘回执重试，同一远端对象只上传一次', async () => {
    const data = await makePayload('s3');
    const jobId = `file-upload:${data.fileId}:1`;
    // Simulate the DB failing after upstream accepted the file and the receipt reached disk.
    await db.query(`CREATE TRIGGER fail_upload_commit BEFORE UPDATE OF "uploadStage" ON files
      WHEN NEW."uploadStage" = 'remote_committed'
      BEGIN SELECT RAISE(ABORT, 'test commit unavailable'); END`);
    worker = queue.process('upload', 1, (job) => processor.uploadToTelegram(job));
    const job = await queue.add('upload', data, { jobId, attempts: 1, removeOnFail: false });
    try {
      await expect(job.finished()).rejects.toThrow('test commit unavailable');
      expect(await job.getState()).toBe('failed');
      expect(await files.findOneByOrFail({ id: data.fileId })).toMatchObject({ uploadStage: 'recoverable' });
      expect(JSON.parse(await readFile(`${data.filePath}.telegram.json`, 'utf8'))).toMatchObject({
        uploadVersion: 1, storageObjectRef: 'receipt-object',
      });
    } finally {
      await db.query('DROP TRIGGER fail_upload_commit');
    }
    // The retry must also succeed when the retained receipt is the only remaining artifact.
    await rm(data.filePath);
    await tasks.recoverStaleProcessingFiles();
    await job.finished();
    expect(await job.getState()).toBe('completed');
    expect(await files.findOneByOrFail({ id: data.fileId })).toMatchObject({
      status: 'ready', storageObjectRef: 'receipt-object',
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadToTelegram).not.toHaveBeenCalled();
  }, 15000);

  it('两个等候 Telegram 账号的作业进入延迟队列，第三个可执行的上传取得执行位', async () => {
    const waiting = [await makePayload('telegram'), await makePayload('telegram')];
    const available = await makePayload('s3');
    const jobs = [];
    for (const data of [...waiting, available]) {
      jobs.push(await queue.add('upload', data, { jobId: `file-upload:${data.fileId}:1`, attempts: 3 }));
    }
    worker = queue.process('upload', 2, (job) => processor.uploadToTelegram(job));
    await Promise.all(jobs.map((job) => job.finished()));
    expect(await files.findOneByOrFail({ id: available.fileId })).toMatchObject({ status: 'ready' });
    for (const data of waiting) {
      const deferred = await queue.getJob(`file-upload:${data.fileId}:1:admission:1`);
      expect(await deferred?.getState()).toBe('delayed');
      expect(deferred?.opts.attempts).toBe(3);
      expect(deferred?.attemptsMade).toBe(0);
      expect(await readFile(data.filePath, 'utf8')).toBe('a');
      expect(await files.findOneByOrFail({ id: data.fileId })).toMatchObject({ status: 'processing' });
    }
    expect(upload).toHaveBeenCalledTimes(1);
    expect(uploadToTelegram).not.toHaveBeenCalled();
  }, 15000);
});

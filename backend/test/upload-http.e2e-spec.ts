import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { readFile, readdir, unlink, mkdtemp, open, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import { FileController } from '../src/file/file.controller';
import { FileService } from '../src/file/file.service';
import { JwtOrApiKeyAuthGuard } from '../src/api-key/jwt-or-api-key.guard';
import { StrictUploadModeGuard } from '../src/file/strict-upload-mode.guard';

// 真实 Nest 路由与 Multer diskStorage；仅认证和 Telegram/数据库边界使用替身。
describe('HTTP multipart upload regression', () => {
  let app: INestApplication;
  const incoming = join(process.cwd(), 'tmp', 'uploads', 'incoming');
  const received: Buffer[] = [];
  let previous: Set<string>;
  const consume = async (file: Express.Multer.File) => {
    try {
      received.push(await readFile(file.path));
      return { name: file.originalname, size: file.size };
    } finally {
      await unlink(file.path);
    }
  };

  beforeAll(async () => {
    const providers = (Reflect.getMetadata('design:paramtypes', FileController) as any[]).map((token) => ({
      provide: token,
      useValue: token === FileService ? {
        upload: consume,
        uploadMultiple: (files: Express.Multer.File[]) => Promise.all(files.map(consume)),
      } : {},
    }));
    const module = await Test.createTestingModule({ controllers: [FileController], providers })
      .overrideGuard(JwtOrApiKeyAuthGuard).useValue({ canActivate(context: any) {
        context.switchToHttp().getRequest().user = { id: 'upload-http-test' };
        return true;
      } })
      .overrideGuard(StrictUploadModeGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  beforeEach(async () => {
    previous = new Set(await readdir(incoming).catch(() => []));
    received.length = 0;
  });
  afterEach(async () => {
    const remaining = (await readdir(incoming).catch(() => [])).filter((name) => !previous.has(name));
    // 清理仅限本用例生成的文件；失败仍保留断言结果。
    await Promise.all(remaining.map((name) => unlink(join(incoming, name))));
    expect(remaining).toEqual([]);
  });
  afterAll(async () => { await app?.close(); });

  it('single-file bytes reach the application unchanged', async () => {
    const bytes = Buffer.from([0, 1, 2, 127, 255]);
    const response = await request(app.getHttpServer()).post('/api/files/upload')
      .attach('file', bytes, 'sample.bin').expect(201);
    expect(response.body).toEqual({ name: 'sample.bin', size: bytes.length });
    expect(received).toEqual([bytes]);
  });

  it('multiple files retain their boundaries and contents', async () => {
    const a = Buffer.from('first file');
    const b = Buffer.from('second file');
    await request(app.getHttpServer()).post('/api/files/upload-multiple')
      .attach('files', a, 'a.txt').attach('files', b, 'b.txt').expect(201);
    expect(received.map((value) => value.toString()).sort()).toEqual([a.toString(), b.toString()].sort());
  });

  it('unexpected multipart fields are rejected and temporary files cleaned up', async () => {
    await request(app.getHttpServer()).post('/api/files/upload')
      .attach('file', Buffer.from('first'), 'a.txt').attach('unexpected', Buffer.from('second'), 'b.txt').expect(400);
    expect(received).toEqual([]);
  });

  it('the 600 MiB receive limit rejects oversized streams without calling the application', async () => {
    // 稀疏文件作为流式输入，避免将 600 MiB fixture 常驻进程内存。
    const directory = await mkdtemp(join(tmpdir(), 'tgtc-upload-limit-'));
    const source = join(directory, 'large.bin');
    const handle = await open(source, 'wx');
    await handle.truncate(600 * 1024 * 1024 + 1);
    await handle.close();
    try {
      await request(app.getHttpServer()).post('/api/files/upload').attach('file', source).expect(413);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(received).toEqual([]);
  }, 30000);

  it('an interrupted upload removes its partial disk file and the next upload still succeeds', async () => {
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/files/upload',
      headers: { 'Content-Type': 'multipart/form-data; boundary=abort-boundary' } });
    req.on('error', () => { /* 本用例主动中断连接。 */ });
    req.write('--abort-boundary\r\nContent-Disposition: form-data; name="file"; filename="aborted.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');
    req.write(Buffer.alloc(4096));
    const newFiles = async () => (await readdir(incoming)).filter((name) => !previous.has(name));
    try {
      for (let i = 0; i < 100 && !(await newFiles()).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await newFiles()).length).toBeGreaterThan(0);
    } finally {
      req.destroy();
    }
    for (let i = 0; i < 100 && (await newFiles()).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await newFiles()).toEqual([]);
    await request(app.getHttpServer()).post('/api/files/upload')
      .attach('file', Buffer.from('after abort'), 'next.txt').expect(201);
    expect(received).toEqual([Buffer.from('after abort')]);
  }, 10000);
});

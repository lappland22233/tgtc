import * as http from 'http';
import * as crypto from 'crypto';
import { Readable, Transform } from 'stream';
import type { AddressInfo } from 'net';

// 注意：本文件不 mock axios —— 验证真实 Axios + 原生 HTTP/HTTPS 传输链路
//（maxRedirects=0 后不再经过 follow-redirects，请求体不应被整包保留）
import { TelegramService } from './telegram.service';

jest.setTimeout(60000);

const MB = 1024 * 1024;

type UploadMode = 'ok' | 'redirect' | 'reject-400' | 'reset' | 'slow' | 'abort-on-first';

interface UploadServerHandle {
  url: string;
  /** 按 URL 统计的请求数（用于断言跳转目标收到零请求） */
  paths: Map<string, number>;
  /** 每个请求的无缓存上传标记，用于验证严格小盘协议真正传至 Bot API。 */
  noCacheHeaders: string[];
  /** 服务端已收到的请求体分片（增量记录） */
  received: Buffer[];
  /** slow 模式：首个分片到达且 socket 已暂停时 resolve */
  pausedPromise: Promise<void>;
  /** abort-on-first 模式：首个分片到达时 resolve */
  firstChunkPromise: Promise<void>;
  close: () => Promise<void>;
}

/** 模块级句柄注册表：用例失败时由 afterEach 统一关闭，避免 Jest 挂起 */
const openServers: UploadServerHandle[] = [];

function startUploadServer(mode: UploadMode): Promise<UploadServerHandle> {
  const received: Buffer[] = [];
  const paths = new Map<string, number>();
  const noCacheHeaders: string[] = [];
  let notifyPaused: (() => void) | undefined;
  let notifyFirstChunk: (() => void) | undefined;
  const pausedPromise = new Promise<void>((resolve) => { notifyPaused = resolve; });
  const firstChunkPromise = new Promise<void>((resolve) => { notifyFirstChunk = resolve; });

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    paths.set(url, (paths.get(url) || 0) + 1);
    const noCacheHeader = req.headers['x-telegram-no-cache'];
    noCacheHeaders.push(Array.isArray(noCacheHeader) ? noCacheHeader[0] || '' : noCacheHeader || '');

    if (url.includes('/getFile')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: { file_id: 'it-file-id', file_path: 'documents/it.bin', file_size: 1 },
      }));
      return;
    }

    if (mode === 'redirect') {
      // 提前响应 3xx，不消费请求体（模拟配置了会跳转的上传地址）
      res.writeHead(302, { location: '/redirected-target' });
      res.end();
      return;
    }

    if (mode === 'reject-400') {
      // 提前响应 400，不消费请求体
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'bad request: payload rejected' }));
      return;
    }

    if (mode === 'reset') {
      // 直接重置 TCP 连接（模拟连接中断）
      req.socket.destroy();
      return;
    }

    // ok / slow / abort-on-first：完整消费请求体
    req.on('data', (chunk: Buffer) => received.push(chunk));

    if (mode === 'slow') {
      // 收到第一个分片即暂停 socket 400ms，制造背压窗口
      req.once('data', () => {
        req.pause();
        notifyPaused?.();
        setTimeout(() => req.resume(), 400);
      });
    }

    if (mode === 'abort-on-first') {
      req.once('data', () => {
        notifyFirstChunk?.();
      });
    }

    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: { document: { file_id: 'it-file-id', file_size: 4 * MB } },
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const handle: UploadServerHandle = {
        url: `http://127.0.0.1:${port}`,
        paths,
        noCacheHeaders,
        received,
        pausedPromise,
        firstChunkPromise,
        close: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          server.closeAllConnections();
        },
      };
      openServers.push(handle);
      resolve(handle);
    });
  });
}

function createService(baseUrl: string): TelegramService {
  const config = {
    TELEGRAM_BOT_TOKEN: '123:it-secret-token',
    TELEGRAM_CHAT_ID: '1',
    TELEGRAM_API_BASE: baseUrl,
  };
  return new TelegramService({
    get: (key: string) => (config as any)[key],
  } as any);
}

function makeFileBuffer(sizeBytes: number): Buffer {
  // 确定性内容：以 64KiB 块为单位重复填充，可校验传输后字节一致
  const block = crypto.randomBytes(64 * 1024);
  const chunks: Buffer[] = [];
  let remaining = sizeBytes;
  while (remaining > 0) {
    const n = Math.min(block.length, remaining);
    chunks.push(n === block.length ? block : block.subarray(0, n));
    remaining -= n;
  }
  return Buffer.concat(chunks);
}

describe('Telegram upload real transport integration (native HTTP, maxRedirects=0)', () => {
  // 用例失败时也要关闭服务器句柄，避免 Jest 因未关闭句柄挂起（注册表见 startUploadServer）
  afterEach(async () => {
    while (openServers.length) {
      await openServers.pop()!.close();
    }
  });

  it('uploads a large stream through the native transport and delivers the full body', async () => {
    const server = await startUploadServer('ok');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(4 * MB);

    const result = await service.uploadFile(Readable.from(fileBuf), 'it.bin', undefined, fileBuf.length);

    expect(result).toEqual({ file_id: 'it-file-id', file_path: '', file_size: 4 * MB });
    // 上传成功不额外请求 /getFile；在自建 Bot API 上这会触发完整媒体下载到 workdir。
    expect([...server.paths.keys()].some((url) => url.includes('/getFile'))).toBe(false);
    const body = Buffer.concat(server.received);
    // 完整请求体送达（multipart 信封包含原始字节）
    expect(body.length).toBeGreaterThan(fileBuf.length);
    expect(body.includes(fileBuf)).toBe(true);
    await server.close();
  });

  it('marks strict no-cache uploads for Bot API local-media release without getFile fallback', async () => {
    const server = await startUploadServer('ok');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(2 * MB);

    const result = await service.uploadFile(Readable.from(fileBuf), 'it.bin', undefined, fileBuf.length, { noCache: true });

    // noCache 上传会附加 localCacheReleased 标记字段（telegram.service.ts L433），用 objectContaining 断言核心字段
    expect(result).toEqual(
      expect.objectContaining({ file_id: 'it-file-id', file_path: '', file_size: 4 * MB }),
    );
    expect(server.noCacheHeaders).toContain('1');
    expect([...server.paths.keys()].some((url) => url.includes('/getFile'))).toBe(false);
    await server.close();
  });

  it('rejects 3xx without following and never re-sends the body to the target', async () => {
    const server = await startUploadServer('redirect');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(2 * MB);

    await expect(service.uploadFile(Readable.from(fileBuf), 'it.bin', undefined, fileBuf.length))
      .rejects.toThrow('重定向');

    // 跳转目标收到的请求数必须为 0：不跟随、不重发
    expect(server.paths.get('/redirected-target')).toBeUndefined();
    // 上传端点仅一次请求（流式上传单次尝试）
    expect([...server.paths.keys()].filter((u) => u.includes('/sendDocument'))).toHaveLength(1);
    await server.close();
  });

  it('releases the source stream when the server rejects early with 400', async () => {
    const server = await startUploadServer('reject-400');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(2 * MB);
    const source = Readable.from(fileBuf);

    await expect(service.uploadFile(source, 'it.bin', undefined, fileBuf.length))
      .rejects.toThrow('payload rejected');

    // 请求结束后源流必须释放（关闭或销毁）
    expect(source.destroyed || source.readableEnded).toBe(true);
    await server.close();
  });

  it('releases the source stream when the connection is reset', async () => {
    const server = await startUploadServer('reset');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(2 * MB);
    const source = Readable.from(fileBuf);

    await expect(service.uploadFile(source, 'it.bin', undefined, fileBuf.length)).rejects.toThrow();
    expect(source.destroyed || source.readableEnded).toBe(true);
    await server.close();
  });

  it('propagates a mid-upload abort and releases the source stream', async () => {
    const server = await startUploadServer('abort-on-first');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(4 * MB);
    const source = Readable.from(fileBuf);
    const controller = new AbortController();

    const pending = service.uploadFile(source, 'it.bin', controller.signal, fileBuf.length);
    await server.firstChunkPromise;
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(source.destroyed || source.readableEnded).toBe(true);
    await server.close();
  });

  it('keeps maxBodyLength enforcement on the native transport', async () => {
    const server = await startUploadServer('ok');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(2 * MB);
    const previousLimit = process.env.TELEGRAM_MAX_UPLOAD_SIZE;
    process.env.TELEGRAM_MAX_UPLOAD_SIZE = String(1 * MB);

    try {
      await expect(service.uploadFile(Readable.from(fileBuf), 'it.bin', undefined, fileBuf.length))
        .rejects.toThrow(/maxBodyLength|larger than/);
    } finally {
      if (previousLimit === undefined) delete process.env.TELEGRAM_MAX_UPLOAD_SIZE;
      else process.env.TELEGRAM_MAX_UPLOAD_SIZE = previousLimit;
    }

    // 服务端不应收到完整请求体（限额在客户端生效）
    expect(Buffer.concat(server.received).length).toBeLessThan(fileBuf.length);
    await server.close();
  });

  it('applies backpressure on slow receivers instead of pre-reading the whole file', async () => {
    const server = await startUploadServer('slow');
    const service = createService(server.url);
    const fileBuf = makeFileBuffer(8 * MB);
    let emitted = 0;
    // 分块生成器源（Readable.from 对 Buffer 会整体单块发出，背压无从体现），
    // 经管道内计数 Transform，让暂停能逐块传播回源
    const CHUNK = 64 * 1024;
    async function* chunkedSource(): AsyncGenerator<Buffer> {
      for (let offset = 0; offset < fileBuf.length; offset += CHUNK) {
        yield fileBuf.subarray(offset, Math.min(offset + CHUNK, fileBuf.length));
      }
    }
    const counting = new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk: Buffer, _enc, cb) {
        emitted += chunk.length;
        cb(null, chunk);
      },
    });
    Readable.from(chunkedSource()).pipe(counting);

    const pending = service.uploadFile(counting, 'it.bin', undefined, fileBuf.length);
    // 等待服务端暂停 socket（背压窗口开始）
    await server.pausedPromise;
    // 给传输链路留出填满有界缓冲的时间（form-data/传输层缓冲 + socket 缓冲）
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 慢接收窗口内，源读取停留在有界缓冲，不得抢先读完整个 8MiB 文件
    expect(emitted).toBeLessThan(fileBuf.length);

    const result = await pending;
    expect(result.file_id).toBe('it-file-id');
    const body = Buffer.concat(server.received);
    expect(body.length).toBeGreaterThan(fileBuf.length);
    expect(body.includes(fileBuf)).toBe(true);
    await server.close();
  });
});

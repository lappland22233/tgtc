import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { Readable } from 'stream';
import {
  CacheSessionCoordinator,
  type CacheBuildSession,
  type SpoolSession,
} from './cache-session-coordinator';
import { DownloadResourceCoordinatorService } from './download-resource-coordinator.service';

/**
 * follower 内存语义回归（阶段 3）。
 *
 * 事故背景：spool / build follower 原先对每次读取都做「复用 256KiB 缓冲 + `Buffer.from(...)`」
 * 双重分配，导致 glibc 原生堆持续扩张并大量换出。重构后每个流只持有一块固定读缓冲，
 * 且**仅在下游已把上一块数据全部消费出流时**才复用它；本组用例保护该所有权契约。
 */
const FILE_ID = '11111111-1111-4111-8111-111111111111';
const CHUNK = 256 * 1024;

function buildCoordinator(cacheDir: string) {
  const resources = new DownloadResourceCoordinatorService();
  const coordinator = new CacheSessionCoordinator({
    diskManager: { getCachePath: (fileId: string) => path.join(cacheDir, fileId) } as never,
    fileAccessMap: new Map<string, number>(),
    logger: new Logger('CacheSessionCoordinatorTest'),
    isShuttingDown: () => false,
    setShuttingDown: () => undefined,
    resources,
  });
  return { coordinator, resources };
}

function buildSession(tmpPath: string, expectedSize: number): CacheBuildSession {
  return {
    fileId: FILE_ID,
    expectedSize,
    tmpPath,
    bytesWritten: 0,
    completed: false,
    events: new EventEmitter(),
    completion: Promise.resolve(),
    abort: () => undefined,
  };
}

/** 逐块复制读取（符合 follower 的所有权契约：跨块保留必须自行复制） */
async function readAll(stream: Readable, pauseMs = 0): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return Buffer.concat(chunks);
}

function makePayload(size: number): Buffer {
  const payload = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) payload[index] = index % 251;
  return payload;
}

describe('CacheSessionCoordinator follower 读取器', () => {
  let dir: string;
  let coordinator: CacheSessionCoordinator;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'follower-reader-'));
    coordinator = buildCoordinator(dir).coordinator;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('多个 follower 并发读取同一会话：内容完整、互不覆盖（含最后一个不满块）', async () => {
    const payload = makePayload(CHUNK * 2 + 137); // 两个整块 + 一个不满块
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    // 会话已完成 → follower 从**正式缓存路径**读取（发布后 tmp 已被 rename）
    await writeFile(path.join(dir, FILE_ID), payload);
    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = payload.length;
    session.completed = true;

    const fast = coordinator.createFollowerStream(session);
    const slow = coordinator.createFollowerStream(session);

    const [fastBytes, slowBytes] = await Promise.all([
      readAll(fast),
      readAll(slow, 2),
    ]);

    expect(fastBytes.equals(payload)).toBe(true);
    expect(slowBytes.equals(payload)).toBe(true);
  });

  it('Range 读取：起点落在块中间、终点落在块中间都精确输出', async () => {
    const payload = makePayload(CHUNK * 2 + 500);
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    await writeFile(path.join(dir, FILE_ID), payload);
    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = payload.length;
    session.completed = true;

    const start = CHUNK - 10;
    const end = CHUNK * 2 + 100;
    const sliced = await readAll(coordinator.createFollowerStream(session, start, end));

    expect(sliced.equals(payload.subarray(start, end + 1))).toBe(true);
  });

  it('会话完成前后切换路径（tmp → 正式缓存）仍能读取完整内容', async () => {
    const payload = makePayload(CHUNK + 4096);
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    const cachePath = path.join(dir, FILE_ID);
    const partial = payload.subarray(0, CHUNK);
    await writeFile(tmpPath, partial);

    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = partial.length;

    const stream = coordinator.createFollowerStream(session);
    const collected = readAll(stream);

    // 发布会把整份内容写到正式缓存路径并置 completed，followers 应无缝续读
    await writeFile(cachePath, payload);
    session.bytesWritten = payload.length;
    session.completed = true;
    session.events.emit('progress');

    expect((await collected).equals(payload)).toBe(true);
  });

  it('读取完成后不再释放会话引用（fileAccessMap 更新）', async () => {
    const payload = makePayload(CHUNK);
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    await writeFile(path.join(dir, FILE_ID), payload);
    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = payload.length;
    session.completed = true;

    await readAll(coordinator.createFollowerStream(session));

    await new Promise((resolve) => setImmediate(resolve));
    expect((coordinator as unknown as { deps: { fileAccessMap: Map<string, number> } })
      .deps.fileAccessMap.get(FILE_ID)).toBeGreaterThan(0);
  });

  it('热路径不再对有效字节做 Buffer.from 复制（所有权直接移交）', async () => {
    const payload = makePayload(CHUNK * 2 + 7);
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    await writeFile(path.join(dir, FILE_ID), payload);
    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = payload.length;
    session.completed = true;

    const fromSpy = jest.spyOn(Buffer, 'from');
    let total = 0;
    for await (const chunk of coordinator.createFollowerStream(session)) {
      total += (chunk as Buffer).length;
    }

    expect(total).toBe(payload.length);
    const copiedBuffers = fromSpy.mock.calls.filter((call) => Buffer.isBuffer(call[0]));
    expect(copiedBuffers).toHaveLength(0);
  });

  it('下游可安全保留块引用：flowing 消费下内容不被后续块覆盖', async () => {
    // 回归背景：曾尝试「复用同一块读缓冲」，在 `pipeline(stream, res)`（flowing 模式）下
    // 上一块仍留在 socket 写队列时就被下一块覆盖，导致下载内容静默损坏。
    // 这里刻意**不复制**块引用，且用 flowing（'data' 事件）消费以复现该时序。
    const payload = makePayload(CHUNK * 3 + 9);
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    await writeFile(path.join(dir, FILE_ID), payload);
    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = payload.length;
    session.completed = true;

    const retained: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = coordinator.createFollowerStream(session);
      stream.on('data', (chunk: Buffer) => retained.push(chunk));
      stream.once('end', () => resolve());
      stream.once('error', reject);
    });

    expect(Buffer.concat(retained).equals(payload)).toBe(true);
    // 所有权契约：每块必须是**独立分配**的底层内存（禁止复用已 push 的缓冲）
    const backingStores = new Set(retained.map((chunk) => chunk.buffer as ArrayBuffer));
    expect(backingStores.size).toBe(retained.length);
  });

  it('消除双重分配：每块数据最多一次缓冲分配，且没有任何额外拷贝', async () => {
    const payload = makePayload(CHUNK * 3 + 5); // 4 块（3 整块 + 1 不满块）
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    await writeFile(path.join(dir, FILE_ID), payload);
    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = payload.length;
    session.completed = true;

    const allocSpy = jest.spyOn(Buffer, 'allocUnsafe');
    const fromSpy = jest.spyOn(Buffer, 'from');
    let total = 0;
    for await (const chunk of coordinator.createFollowerStream(session)) {
      total += (chunk as Buffer).length;
    }

    expect(total).toBe(payload.length);
    // 读缓冲分配次数不超过数据块数：旧实现是「每流一块缓冲 + 每块一次 Buffer.from 拷贝」
    const chunkAllocations = allocSpy.mock.calls.filter((call) => call[0] === CHUNK).length;
    expect(chunkAllocations).toBeLessThanOrEqual(4);
    expect(fromSpy.mock.calls.filter((call) => Buffer.isBuffer(call[0]))).toHaveLength(0);
  });

  it('消费者提前断开：不遗留会话监听器，也不影响后续读取', async () => {
    const payload = makePayload(CHUNK * 3);
    const tmpPath = path.join(dir, `${FILE_ID}.tmp`);
    await writeFile(path.join(dir, FILE_ID), payload);
    const session = buildSession(tmpPath, payload.length);
    session.bytesWritten = payload.length;
    session.completed = true;

    const aborted = coordinator.createFollowerStream(session);
    aborted.on('error', () => undefined);
    aborted.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    // 断开后不得残留 progress/failed 监听器（否则会话事件会持续泄漏引用）
    expect(session.events.listenerCount('progress')).toBe(0);
    expect(session.events.listenerCount('failed')).toBe(0);

    // 后续 follower 仍能读完整内容
    expect((await readAll(coordinator.createFollowerStream(session))).equals(payload)).toBe(true);
  });

  it('spool follower：消费者计数随创建/关闭变化，内容可完整重放', async () => {
    const payload = makePayload(CHUNK + 123);
    const spoolPath = path.join(dir, `${FILE_ID}.spool`);
    await writeFile(spoolPath, payload);
    const session: SpoolSession = {
      fileId: FILE_ID,
      expectedSize: payload.length,
      spoolPath,
      bytesWritten: payload.length,
      completed: true,
      events: new EventEmitter(),
      completion: Promise.resolve(),
      abort: () => undefined,
      consumerCount: 0,
    };

    const stream = (coordinator as unknown as {
      createSpoolFollowerStream: (s: SpoolSession, start?: number, end?: number) => Readable;
    }).createSpoolFollowerStream(session);
    expect(session.consumerCount).toBe(1);

    expect((await readAll(stream)).equals(payload)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(session.consumerCount).toBe(0);
  });
});

/**
 * direct（有界滚动直通）流的背压语义验收。
 *
 * 事故背景：`Readable.from(..., { highWaterMark })` 在 object-mode 下把窗口值解释成
 * 「可排队对象数量」，16 MiB 会被当成「可排队 16 个任意大小的块」——内存与文件大小挂钩。
 */
describe('CacheSessionCoordinator direct 直通流（字节模式与窗口约束）', () => {
  let dir: string;
  let coordinator: CacheSessionCoordinator;
  let resources: DownloadResourceCoordinatorService;

  /** 模拟上游：按固定块大小产出，便于验证 Range 丢弃与背压 */
  function upstreamOf(payload: Buffer, chunkSize = 64 * 1024): Readable {
    let sent = 0;
    return new Readable({
      read() {
        if (sent >= payload.length) {
          this.push(null);
          return;
        }
        const end = Math.min(payload.length, sent + chunkSize);
        const chunk = payload.subarray(sent, end);
        sent = end;
        this.push(chunk);
      },
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'direct-stream-'));
    const built = buildCoordinator(dir);
    coordinator = built.coordinator;
    resources = built.resources;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function openDirect(fileId: string, payload: Buffer, options?: {
    start?: number;
    end?: number;
    windowBytes?: number;
  }) {
    return coordinator.getDirectStream(
      fileId,
      async () => ({ stream: upstreamOf(payload), info: { file_size: payload.length } }),
      options?.start ?? 0,
      options?.end,
      { windowBytes: options?.windowBytes, expectedSize: payload.length },
    );
  }

  it('显式字节模式：objectMode=false，highWaterMark 等于规范化后的窗口字节数', async () => {
    const payload = makePayload(4096);
    const { stream } = await openDirect('direct-a', payload, { windowBytes: 2 * 1024 * 1024 });

    expect(stream.readableObjectMode).toBe(false);
    expect(stream.readableHighWaterMark).toBe(2 * 1024 * 1024);

    expect((await readAll(stream)).equals(payload)).toBe(true);
  });

  it('窗口越界一律收敛到 1-4MiB（16MiB 不再被当作对象数量）', async () => {
    const payload = makePayload(1024);
    const huge = await openDirect('direct-b', payload, { windowBytes: 16 * 1024 * 1024 });
    expect(huge.stream.readableHighWaterMark).toBe(4 * 1024 * 1024);
    await readAll(huge.stream);

    // 非法覆盖值（0）回退到配置窗口（默认 1MiB）
    const fallback = await openDirect('direct-c', payload, { windowBytes: 0 });
    expect(fallback.stream.readableHighWaterMark).toBe(1 * 1024 * 1024);
    await readAll(fallback.stream);

    // 低于下限的覆盖值收敛到 1MiB
    const tiny = await openDirect('direct-d', payload, { windowBytes: 1024 });
    expect(tiny.stream.readableHighWaterMark).toBe(1 * 1024 * 1024);
    await readAll(tiny.stream);
  });

  it('Range：丢弃 start 之前的字节，并在 end 之后停止读取', async () => {
    const payload = makePayload(300 * 1024);
    const start = 100 * 1024 + 7;
    const end = 200 * 1024 + 13;

    const { stream } = await openDirect('direct-range', payload, { start, end });
    const sliced = await readAll(stream);

    expect(sliced.equals(payload.subarray(start, end + 1))).toBe(true);
  });

  it('运行观测：活跃 direct 流数与窗口总量随打开/释放变化', async () => {
    const payload = makePayload(4096);
    expect(coordinator.activeDirectStreamCount).toBe(0);
    expect(coordinator.activeDirectWindowBytesTotal).toBe(0);

    const { stream } = await openDirect('direct-metrics', payload, { windowBytes: 2 * 1024 * 1024 });
    expect(coordinator.activeDirectStreamCount).toBe(1);
    expect(coordinator.activeDirectWindowBytesTotal).toBe(2 * 1024 * 1024);

    await readAll(stream);
    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.activeDirectStreamCount).toBe(0);
    expect(coordinator.activeDirectWindowBytesTotal).toBe(0);
  });

  it('消费者关闭 / 上游报错 / 正常结束：上游租约都只释放一次', async () => {
    const releaseLease = jest.fn();
    jest.spyOn(resources, 'acquireUpstreamSlot').mockResolvedValue({
      id: 'lease-1',
      weight: 1,
      active: true,
      release: releaseLease,
    } as never);

    // 正常读完：生成器结束释放；随后调用方与流 close 再各调一次也必须无效
    const payload = makePayload(8 * 1024);
    const done = await openDirect('direct-done', payload);
    await readAll(done.stream);
    done.release();
    done.stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(releaseLease).toHaveBeenCalledTimes(1);

    // 上游报错：错误路径释放
    releaseLease.mockClear();
    const failing = new Readable({
      read() {
        this.destroy(new Error('upstream boom'));
      },
    });
    const broken = await coordinator.getDirectStream(
      'direct-broken',
      async () => ({ stream: failing, info: { file_size: 10 } }),
    );
    await expect(readAll(broken.stream)).rejects.toThrow('upstream boom');
    broken.release();
    expect(releaseLease).toHaveBeenCalledTimes(1);

    // 消费者提前关闭
    releaseLease.mockClear();
    const closed = await openDirect('direct-closed', payload);
    closed.stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });
});

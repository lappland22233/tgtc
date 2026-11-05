/**
 * S3 兼容协议真实端点 e2e（Spec 测试计划：MinIO 上传/Range 下载/覆盖/删除）。
 *
 * 运行方式（默认跳过，不影响常规 CI）：
 *   1. 启动 MinIO：docker run -p 9000:9000 -e MINIO_ROOT_USER=minioadmin \
 *        -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
 *   2. 创建桶（mc mb local/tgtc-e2e 或控制台）
 *   3. 设置环境变量后运行：
 *        S3_E2E_ENDPOINT=http://127.0.0.1:9000 S3_E2E_BUCKET=tgtc-e2e \
 *        S3_E2E_ACCESS_KEY_ID=minioadmin S3_E2E_SECRET_ACCESS_KEY=minioadmin \
 *        npx jest --maxWorkers=2 s3-storage.e2e
 *
 * 覆盖：真实分片上传（>8MB 触发 multipart）、head、全量/Range 下载字节一致性、
 * 覆盖上传对象键不冲突、删除幂等。全部使用真实 AWS SDK（不 mock）。
 */
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { S3StorageDriver } from '../src/storage/drivers/s3.driver';
import type { StorageAccountContext } from '../src/storage/storage.types';

const endpoint = process.env.S3_E2E_ENDPOINT;
const bucket = process.env.S3_E2E_BUCKET;
const accessKeyId = process.env.S3_E2E_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_E2E_SECRET_ACCESS_KEY;
const enabled = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

const describeE2E = enabled ? describe : describe.skip;
if (!enabled) {
  // eslint-disable-next-line no-console
  console.log('[s3-storage.e2e] 未配置 S3_E2E_* 环境变量，跳过真实端点 e2e（配置 MinIO 后可运行）');
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describeE2E('S3 真实端点 e2e（MinIO）', () => {
  jest.setTimeout(120_000);
  const driver = new S3StorageDriver();
  const prefix = `e2e-${randomUUID().slice(0, 8)}`;
  const ctx: StorageAccountContext = {
    accountId: `e2e-${randomUUID()}`,
    type: 's3',
    config: {
      endpoint,
      bucket: bucket!,
      region: process.env.S3_E2E_REGION || 'us-east-1',
      forcePathStyle: true,
      prefix,
    },
    credential: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
  };
  const created: string[] = [];

  afterAll(async () => {
    for (const ref of created) {
      await driver.deleteObject(ctx, ref).catch(() => {});
    }
  });

  it('probe：桶可达', async () => {
    const probe = await driver.probeAccount(ctx);
    expect(probe.ok).toBe(true);
  });

  it('小文件上传 → head → 全量下载字节一致 → Range 下载 → 删除幂等', async () => {
    const payload = Buffer.from('hello tgtc storage e2e — 中文与二进制\x00\x01\x02');
    const uploaded = await driver.upload(ctx, {
      objectName: 'small-测试.bin',
      openStream: () => Readable.from([payload]),
      knownLength: payload.length,
      mimeType: 'application/octet-stream',
    });
    created.push(uploaded.objectRef);
    expect(uploaded.objectRef.startsWith(`${prefix}/`)).toBe(true);
    expect(uploaded.size).toBe(payload.length);

    const head = await driver.headObject(ctx, uploaded.objectRef);
    expect(head).toEqual({ exists: true, size: payload.length });

    const full = await driver.openDownloadStream(ctx, { objectRef: uploaded.objectRef });
    expect(full.size).toBe(payload.length);
    expect(await streamToBuffer(full.stream)).toEqual(payload);

    const ranged = await driver.openDownloadStream(ctx, {
      objectRef: uploaded.objectRef,
      range: { start: 6, end: 9 },
    });
    expect(ranged.size).toBe(payload.length);
    expect(await streamToBuffer(ranged.stream)).toEqual(payload.subarray(6, 10));

    await driver.deleteObject(ctx, uploaded.objectRef);
    expect(await driver.headObject(ctx, uploaded.objectRef)).toEqual({ exists: false });
    // 删除幂等：不存在的对象再删不抛错
    await expect(driver.deleteObject(ctx, uploaded.objectRef)).resolves.toBeUndefined();
    created.pop();
  });

  it('大文件（>8MB）分片上传与 Range 下载字节一致', async () => {
    const size = 10 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) payload[i] = i % 251;
    const uploaded = await driver.upload(ctx, {
      objectName: 'large.bin',
      openStream: () => Readable.from([payload]),
      knownLength: size,
    });
    created.push(uploaded.objectRef);

    const head = await driver.headObject(ctx, uploaded.objectRef);
    expect(head.size).toBe(size);

    const start = 8 * 1024 * 1024;
    const ranged = await driver.openDownloadStream(ctx, {
      objectRef: uploaded.objectRef,
      range: { start, end: start + 1023 },
    });
    expect(ranged.size).toBe(size);
    expect(await streamToBuffer(ranged.stream)).toEqual(payload.subarray(start, start + 1024));
  });

  it('覆盖语义：同名两次上传产生不同对象键（旧对象不被覆盖，可独立清理）', async () => {
    const first = await driver.upload(ctx, {
      objectName: 'same-name.txt',
      openStream: () => Readable.from([Buffer.from('v1')]),
      knownLength: 2,
    });
    const second = await driver.upload(ctx, {
      objectName: 'same-name.txt',
      openStream: () => Readable.from([Buffer.from('v2-longer')]),
      knownLength: 9,
    });
    created.push(first.objectRef, second.objectRef);
    expect(first.objectRef).not.toEqual(second.objectRef);
    // 旧对象仍然可读（共享引用检查通过后才由业务层删除）
    expect((await driver.headObject(ctx, first.objectRef)).exists).toBe(true);
    expect((await driver.headObject(ctx, second.objectRef)).size).toBe(9);
  });
});
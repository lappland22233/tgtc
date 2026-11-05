import { Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { S3BackendConfig } from '../../common/entities/storage-backend.entity';
import { toStorageAccountError } from '../storage-errors.util';
import {
  sanitizeObjectName,
  StorageAccountContext,
  StorageAccountError,
  StorageBackendDriver,
  StorageDownloadParams,
  StorageDownloadResult,
  StorageProbeResult,
  StorageUploadParams,
  StorageUploadResult,
} from '../storage.types';

/** 分片上传参数：8MB 分片 × 4 并发（600MB 上限文件约 75 片，内存占用有界） */
const PART_SIZE_BYTES = 8 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 4;

/**
 * S3 兼容协议驱动（MinIO / Cloudflare R2 / 阿里 OSS / AWS S3）。
 *
 * - 上传走 `@aws-sdk/lib-storage` Upload（自动分片，失败自动 abort 清理残留分片，
 *   `leavePartsOnError=false`）；对象键 = `{prefix}/{uuid}-{sanitized-name}`，
 *   uuid 保证覆盖上传/并发上传绝不冲突（同步上传路径在 File 记录创建前执行，
 *   拿不到 fileId，故用随机 uuid 而非 fileId 作唯一前缀）。
 * - 下载 GetObjectCommand 原生透传 Range；返回对象**总大小**（Content-Range 解析），
 *   与 TG 回源 info.file_size 口径一致。
 * - 无配额概念（getQuota 不实现），调度不启用配额因子。
 *
 * 客户端按「账号 + 配置 + 凭据指纹」缓存复用（凭据轮换后指纹变化自动重建）。
 */
@Injectable()
export class S3StorageDriver implements StorageBackendDriver {
  readonly type = 's3' as const;
  private readonly clients = new Map<string, S3Client>();

  async upload(ctx: StorageAccountContext, params: StorageUploadParams): Promise<StorageUploadResult> {
    const config = ctx.config as S3BackendConfig;
    const client = this.clientFor(ctx);
    const key = this.objectKey(config, params.objectName);
    const stream = params.openStream();
    const upload = new Upload({
      client,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: stream,
        ContentType: params.mimeType || 'application/octet-stream',
      },
      partSize: PART_SIZE_BYTES,
      queueSize: UPLOAD_QUEUE_SIZE,
      // 失败必须清理已上传分片，避免桶内残留计费对象
      leavePartsOnError: false,
    });
    const onAbort = () => { void upload.abort().catch(() => {}); };
    if (params.signal) {
      if (params.signal.aborted) {
        stream.destroy();
        throw new StorageAccountError('上传已取消', 'other');
      }
      params.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      await upload.done();
      return { objectRef: key, size: params.knownLength };
    } catch (error) {
      throw this.classify(error, 'S3 上传失败');
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
      // 失败/中止时销毁未消费完的流（成功路径流已被 Upload 读完，readableEnded=true 自然跳过）；
      // 路由层换号时也会兜底销毁，双重清理幂等无副作用
      if (!stream.destroyed && !stream.readableEnded) {
        try {
          stream.destroy();
        } catch {
          // 忽略清理异常
        }
      }
    }
  }

  async openDownloadStream(ctx: StorageAccountContext, params: StorageDownloadParams): Promise<StorageDownloadResult> {
    const config = ctx.config as S3BackendConfig;
    const client = this.clientFor(ctx);
    const range = params.range
      ? `bytes=${params.range.start}-${params.range.end ?? ''}`
      : undefined;
    try {
      const response = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: params.objectRef,
        Range: range,
      }), { abortSignal: params.signal });
      const body = response.Body;
      if (!body || typeof (body as Readable).pipe !== 'function') {
        throw new StorageAccountError('S3 响应体不是可读流', 'other');
      }
      return {
        stream: body as Readable,
        size: this.totalSizeOf(response.ContentRange, response.ContentLength, params.range),
      };
    } catch (error) {
      throw this.classify(error, 'S3 取流失败');
    }
  }

  async headObject(ctx: StorageAccountContext, objectRef: string): Promise<{ exists: boolean; size?: number }> {
    const config = ctx.config as S3BackendConfig;
    try {
      const response = await this.clientFor(ctx).send(new HeadObjectCommand({
        Bucket: config.bucket,
        Key: objectRef,
      }));
      return { exists: true, size: response.ContentLength };
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return { exists: false };
      throw this.classify(error, 'S3 head 失败');
    }
  }

  async deleteObject(ctx: StorageAccountContext, objectRef: string): Promise<void> {
    const config = ctx.config as S3BackendConfig;
    try {
      // S3 DeleteObject 对不存在的键也返回成功（幂等）
      await this.clientFor(ctx).send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: objectRef,
      }));
    } catch (error) {
      throw this.classify(error, 'S3 删除失败');
    }
  }

  async probeAccount(ctx: StorageAccountContext): Promise<StorageProbeResult> {
    const config = ctx.config as S3BackendConfig;
    const startedAt = Date.now();
    try {
      await this.clientFor(ctx).send(new HeadBucketCommand({ Bucket: config.bucket }));
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      const classified = this.classify(error, 'S3 连通性测试失败');
      return { ok: false, latencyMs: Date.now() - startedAt, error: classified.message };
    }
  }

  private objectKey(config: S3BackendConfig, objectName: string): string {
    const prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '');
    const name = `${randomUUID()}-${sanitizeObjectName(objectName)}`;
    return prefix ? `${prefix}/${name}` : name;
  }

  /** Content-Range: bytes 0-99/1234 → 总大小 1234；无 Range 时即 ContentLength */
  private totalSizeOf(
    contentRange: string | undefined,
    contentLength: number | undefined,
    range?: { start: number; end?: number },
  ): number {
    if (contentRange) {
      const total = Number(contentRange.split('/')[1]);
      if (Number.isFinite(total) && total >= 0) return total;
    }
    if (range && typeof contentLength === 'number') {
      // 上游未回 Content-Range（非标准实现）：范围长度 + 起点近似总大小下界
      return range.start + contentLength;
    }
    return contentLength ?? 0;
  }

  private clientFor(ctx: StorageAccountContext): S3Client {
    const config = ctx.config as S3BackendConfig;
    const accessKeyId = String(ctx.credential.accessKeyId ?? '');
    const secretAccessKey = String(ctx.credential.secretAccessKey ?? '');
    // 指纹含凭据哈希：轮换后自动重建客户端；指纹本身不可逆，不落日志
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(config) + accessKeyId + secretAccessKey)
      .digest('hex')
      .slice(0, 16);
    const cacheKey = `${ctx.accountId}:${fingerprint}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;
    // 同账号旧指纹客户端销毁，避免连接池泄漏
    for (const [key, client] of this.clients.entries()) {
      if (key.startsWith(`${ctx.accountId}:`)) {
        client.destroy();
        this.clients.delete(key);
      }
    }
    const client = new S3Client({
      region: config.region || 'us-east-1',
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle === true,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.clients.set(cacheKey, client);
    return client;
  }

  /** AWS SDK 错误分类：先按语义名，再按 HTTP 状态码 */
  private classify(error: unknown, fallback: string): StorageAccountError {
    const name = (error as { name?: string })?.name ?? '';
    if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken|InvalidToken/i.test(name)) {
      return new StorageAccountError(`${fallback}（凭据/权限错误）`, 'auth', 403);
    }
    if (/SlowDown|Throttl|RequestLimitExceeded/i.test(name)) {
      return new StorageAccountError(`${fallback}（上游限流）`, 'flood', 503);
    }
    if (/NoSuchBucket/i.test(name)) {
      return new StorageAccountError(`${fallback}（桶不存在）`, 'unavailable', 404);
    }
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (typeof status === 'number') {
      return toStorageAccountError({ response: { status } }, fallback);
    }
    return toStorageAccountError(error, fallback);
  }
}
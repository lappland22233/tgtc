import { Injectable } from '@nestjs/common';
import { createClient, WebDAVClient } from 'webdav';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { WebDavBackendConfig } from '../../common/entities/storage-backend.entity';
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

/**
 * WebDAV 协议驱动（Nextcloud / Alist / 坚果云等）。
 *
 * - PUT 流式上传（显式 contentLength，避免 chunked 编码被部分服务端拒绝）；
 *   对象路径 = `{rootPath}/{uuid}-{sanitized-name}`，uuid 保证覆盖上传不冲突；
 *   父目录按需递归创建（405/已存在视为成功）。
 * - GET createReadStream 原生 Range；先 PROPFIND stat 拿对象总大小，
 *   与 TG 回源 info.file_size 口径一致。
 * - 423 Locked / 507 Insufficient Storage 归类为可换号失败（见 classifyHttpStatus）。
 * - 无配额概念（getQuota 不实现），调度不启用配额因子。
 */
@Injectable()
export class WebDavStorageDriver implements StorageBackendDriver {
  readonly type = 'webdav' as const;
  private readonly clients = new Map<string, WebDAVClient>();

  async upload(ctx: StorageAccountContext, params: StorageUploadParams): Promise<StorageUploadResult> {
    const client = this.clientFor(ctx);
    const config = ctx.config as WebDavBackendConfig;
    const dir = this.rootDir(config);
    const objectPath = `${dir}/${randomUUID()}-${sanitizeObjectName(params.objectName)}`;
    try {
      await this.ensureDirectory(client, dir);
      const stream = params.openStream();
      const onAbort = () => stream.destroy();
      if (params.signal) {
        if (params.signal.aborted) {
          stream.destroy();
          throw new StorageAccountError('上传已取消', 'other');
        }
        params.signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const ok = await client.putFileContents(objectPath, stream, {
          contentLength: params.knownLength,
          overwrite: false,
        });
        if (!ok) throw new StorageAccountError('WebDAV PUT 未确认成功', 'other');
      } finally {
        params.signal?.removeEventListener('abort', onAbort);
        // 失败/中止时销毁未消费完的流（成功路径 readableEnded=true 自然跳过）
        if (!stream.destroyed && !stream.readableEnded) {
          try {
            stream.destroy();
          } catch {
            // 忽略清理异常
          }
        }
      }
      // objectRef 存相对根 URL 的路径（与驱动内部拼接规则一致）
      return { objectRef: objectPath, size: params.knownLength };
    } catch (error) {
      throw toStorageAccountError(error, 'WebDAV 上传失败');
    }
  }

  async openDownloadStream(ctx: StorageAccountContext, params: StorageDownloadParams): Promise<StorageDownloadResult> {
    const client = this.clientFor(ctx);
    try {
      const stat = await client.stat(params.objectRef);
      const size = Number((stat as { size?: number }).size ?? 0);
      const range = params.range
        ? { start: params.range.start, end: params.range.end ?? Math.max(0, size - 1) }
        : undefined;
      const stream = client.createReadStream(params.objectRef, range ? { range } : undefined);
      // webdav 库返回 ReadableLike（运行时即 Node Readable），收窄为流接口统一形状
      return { stream: stream as unknown as Readable, size };
    } catch (error) {
      throw toStorageAccountError(error, 'WebDAV 取流失败');
    }
  }

  async headObject(ctx: StorageAccountContext, objectRef: string): Promise<{ exists: boolean; size?: number }> {
    const client = this.clientFor(ctx);
    try {
      const exists = await client.exists(objectRef);
      if (!exists) return { exists: false };
      const stat = await client.stat(objectRef);
      return { exists: true, size: Number((stat as { size?: number }).size ?? 0) };
    } catch (error) {
      const status = (error as { status?: number; response?: { status?: number } })?.status
        ?? (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) return { exists: false };
      throw toStorageAccountError(error, 'WebDAV head 失败');
    }
  }

  async deleteObject(ctx: StorageAccountContext, objectRef: string): Promise<void> {
    const client = this.clientFor(ctx);
    try {
      await client.deleteFile(objectPathNormalize(objectRef));
    } catch (error) {
      const status = (error as { status?: number; response?: { status?: number } })?.status
        ?? (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) return; // 对象不存在视为成功（幂等）
      throw toStorageAccountError(error, 'WebDAV 删除失败');
    }
  }

  async probeAccount(ctx: StorageAccountContext): Promise<StorageProbeResult> {
    const client = this.clientFor(ctx);
    const config = ctx.config as WebDavBackendConfig;
    const startedAt = Date.now();
    try {
      // PROPFIND 根目录：验证 URL/凭据/权限三要素
      await client.getDirectoryContents(this.rootDir(config), { deep: false });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      const status = (error as { status?: number; response?: { status?: number } })?.status
        ?? (error as { response?: { status?: number } })?.response?.status;
      // 根目录尚不存在（404）：尝试创建后复测（首次配置即可用）
      if (status === 404) {
        try {
          await this.ensureDirectory(client, this.rootDir(config));
          return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (createError) {
          return {
            ok: false,
            latencyMs: Date.now() - startedAt,
            error: toStorageAccountError(createError, 'WebDAV 根目录创建失败').message,
          };
        }
      }
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: toStorageAccountError(error, 'WebDAV 连通性测试失败').message,
      };
    }
  }

  private rootDir(config: WebDavBackendConfig): string {
    const root = (config.rootPath || '').replace(/^\/+|\/+$/g, '');
    return root ? `/${root}` : '/';
  }

  /** 递归创建目录；已存在（405/409）视为成功 */
  private async ensureDirectory(client: WebDAVClient, dir: string): Promise<void> {
    if (dir === '/') return;
    try {
      await client.createDirectory(dir, { recursive: true });
    } catch (error) {
      const status = (error as { status?: number; response?: { status?: number } })?.status
        ?? (error as { response?: { status?: number } })?.response?.status;
      if (status === 405 || status === 409 || status === 301) return;
      // 部分服务端不支持 recursive MKCOL：逐级降级创建
      const segments = dir.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments) {
        current += `/${segment}`;
        try {
          await client.createDirectory(current);
        } catch (stepError) {
          const stepStatus = (stepError as { status?: number; response?: { status?: number } })?.status
            ?? (stepError as { response?: { status?: number } })?.response?.status;
          if (stepStatus !== 405 && stepStatus !== 409 && stepStatus !== 301) {
            throw toStorageAccountError(stepError, 'WebDAV 目录创建失败');
          }
        }
      }
    }
  }

  private clientFor(ctx: StorageAccountContext): WebDAVClient {
    const config = ctx.config as WebDavBackendConfig;
    const username = String(ctx.credential.username ?? '');
    const password = String(ctx.credential.password ?? '');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(config) + username + password)
      .digest('hex')
      .slice(0, 16);
    const cacheKey = `${ctx.accountId}:${fingerprint}`;
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;
    for (const key of this.clients.keys()) {
      if (key.startsWith(`${ctx.accountId}:`)) this.clients.delete(key);
    }
    const client = createClient(config.url, { username, password });
    this.clients.set(cacheKey, client);
    return client;
  }
}

/** WebDAV 路径规范化：保证以 / 开头（objectRef 由本驱动生成，防御历史数据） */
function objectPathNormalize(objectRef: string): string {
  return objectRef.startsWith('/') ? objectRef : `/${objectRef}`;
}
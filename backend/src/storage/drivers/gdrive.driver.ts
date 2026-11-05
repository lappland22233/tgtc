import { Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { GDriveBackendConfig } from '../../common/entities/storage-backend.entity';
import { GDriveOAuthService } from '../gdrive-oauth.service';
import { StorageBackendsService } from '../storage-backends.service';
import { classifyHttpStatus, toStorageAccountError } from '../storage-errors.util';
import {
  sanitizeObjectName,
  StorageAccountContext,
  StorageAccountError,
  StorageBackendDriver,
  StorageDownloadParams,
  StorageDownloadResult,
  StorageProbeResult,
  StorageQuota,
  StorageUploadParams,
  StorageUploadResult,
} from '../storage.types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
/** 小文件 multipart 阈值（Google 建议 <=5MB 走 multipart） */
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;
/** resumable 分块大小：8MB（Google 要求 256KB 的倍数） */
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
/** 单块网络/5xx 重试次数（resumable 会话内重试不重传整个文件） */
const CHUNK_RETRY_LIMIT = 3;
/** 流式上游错误体只读取有限字节，足以解析 Google API 的限流 reason。 */
const MAX_STREAMED_ERROR_BODY_BYTES = 64 * 1024;
/** 应用根文件夹名（drive.file scope 下仅本应用可见/可管） */
const ROOT_FOLDER_NAME = 'TGTC';

/**
 * Google Drive 驱动（个人账号 OAuth，drive.file scope）。
 *
 * - 上传：<=5MB multipart；>5MB resumable session（分块 PUT + 308 续传 +
 *   块级重试，中断可 DELETE 会话清理）；对象引用 = Drive fileId。
 * - 下载：files.get?alt=media + Range 原生透传；返回对象总大小。
 * - 配额：about.get storageQuota（个人账号 15GB），调度器按剩余配额硬准入，
 *   写满自动换下一个账号——账号池扩展存储空间的落点。
 * - 凭据：refresh_token 经 google-auth-library 自动刷新 access_token；
 *   invalid_grant → auth 类失败（账号转 degraded/revoked，需重新授权）。
 * - 首次上传自动创建 TGTC/ 根文件夹并回填 config.rootFolderId。
 */
@Injectable()
export class GDriveStorageDriver implements StorageBackendDriver {
  readonly type = 'gdrive' as const;
  private readonly clients = new Map<string, { fingerprint: string; client: OAuth2Client }>();

  constructor(
    private readonly oauth: GDriveOAuthService,
    private readonly backends: StorageBackendsService,
  ) {}

  async upload(ctx: StorageAccountContext, params: StorageUploadParams): Promise<StorageUploadResult> {
    const token = await this.accessToken(ctx);
    const rootFolderId = await this.ensureRootFolder(ctx, token);
    const name = `${randomUUID()}-${sanitizeObjectName(params.objectName)}`;
    const mimeType = params.mimeType || 'application/octet-stream';
    const metadata = { name, parents: [rootFolderId], mimeType };
    try {
      if (params.knownLength <= MULTIPART_THRESHOLD_BYTES) {
        return await this.multipartUpload(token, metadata, mimeType, params);
      }
      return await this.resumableUpload(token, metadata, mimeType, params);
    } catch (error) {
      throw this.classify(error, 'GDrive 上传失败');
    }
  }

  async openDownloadStream(ctx: StorageAccountContext, params: StorageDownloadParams): Promise<StorageDownloadResult> {
    const token = await this.accessToken(ctx);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (params.range) {
      headers.Range = `bytes=${params.range.start}-${params.range.end ?? ''}`;
    }
    try {
      const response = await axios.get<Readable>(
        `${DRIVE_API}/files/${encodeURIComponent(params.objectRef)}`,
        {
          params: { alt: 'media' },
          headers,
          responseType: 'stream',
          signal: params.signal,
          timeout: 60_000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        },
      );
      const contentRange = response.headers['content-range'] as string | undefined;
      const contentLength = Number(response.headers['content-length'] ?? 0);
      let size = contentLength;
      if (contentRange) {
        const total = Number(contentRange.split('/')[1]);
        if (Number.isFinite(total)) size = total;
      } else if (params.range) {
        size = params.range.start + contentLength;
      }
      return { stream: response.data, size };
    } catch (error) {
      throw await this.classifyDownloadError(error, 'GDrive 取流失败');
    }
  }

  async headObject(ctx: StorageAccountContext, objectRef: string): Promise<{ exists: boolean; size?: number }> {
    const token = await this.accessToken(ctx);
    try {
      const response = await axios.get<{ size?: string; trashed?: boolean }>(
        `${DRIVE_API}/files/${encodeURIComponent(objectRef)}`,
        {
          params: { fields: 'id,size,trashed' },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15_000,
        },
      );
      if (response.data?.trashed) return { exists: false };
      return { exists: true, size: Number(response.data?.size ?? 0) };
    } catch (error) {
      const status = (error as AxiosError)?.response?.status;
      if (status === 404) return { exists: false };
      throw this.classify(error, 'GDrive head 失败');
    }
  }

  async deleteObject(ctx: StorageAccountContext, objectRef: string): Promise<void> {
    const token = await this.accessToken(ctx);
    try {
      // drive.file scope 下本应用创建的文件可永久删除（不进回收站）
      await axios.delete(`${DRIVE_API}/files/${encodeURIComponent(objectRef)}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      });
    } catch (error) {
      const status = (error as AxiosError)?.response?.status;
      if (status === 404) return; // 幂等
      throw this.classify(error, 'GDrive 删除失败');
    }
  }

  async probeAccount(ctx: StorageAccountContext): Promise<StorageProbeResult> {
    const startedAt = Date.now();
    try {
      const token = await this.accessToken(ctx);
      await axios.get(`${DRIVE_API}/about`, {
        params: { fields: 'storageQuota' },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: this.classify(error, 'GDrive 连通性测试失败').message,
      };
    }
  }

  async getQuota(ctx: StorageAccountContext): Promise<StorageQuota> {
    const client = await this.authorizedClient(ctx);
    return this.oauth.fetchQuota(client);
  }

  /** 小文件 multipart（元数据 + 字节一体提交） */
  private async multipartUpload(
    token: string,
    metadata: Record<string, unknown>,
    mimeType: string,
    params: StorageUploadParams,
  ): Promise<StorageUploadResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of params.openStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const boundary = `tgtc_${randomUUID().replace(/-/g, '')}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const response = await axios.post<{ id: string; size?: string }>(
      DRIVE_UPLOAD,
      payload,
      {
        params: { uploadType: 'multipart', fields: 'id,size' },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        signal: params.signal,
        timeout: 120_000,
        maxBodyLength: Infinity,
      },
    );
    return { objectRef: response.data.id, size: Number(response.data.size ?? params.knownLength) };
  }

  /** 大文件 resumable session：initiate → 分块 PUT（308 续传 + 块级重试） */
  private async resumableUpload(
    token: string,
    metadata: Record<string, unknown>,
    mimeType: string,
    params: StorageUploadParams,
  ): Promise<StorageUploadResult> {
    const init = await axios.post(DRIVE_UPLOAD, metadata, {
      params: { uploadType: 'resumable', fields: 'id,size' },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(params.knownLength),
      },
      timeout: 30_000,
    });
    const sessionUri = init.headers.location as string | undefined;
    if (!sessionUri) throw new StorageAccountError('GDrive resumable 会话未返回上传地址', 'other');

    const abortSession = () => {
      void axios.delete(sessionUri, { timeout: 10_000 }).catch(() => {});
    };
    if (params.signal?.aborted) {
      abortSession();
      throw new StorageAccountError('上传已取消', 'other');
    }
    params.signal?.addEventListener('abort', abortSession, { once: true });

    try {
      let offset = 0;
      const total = params.knownLength;
      for await (const chunk of this.chunked(params.openStream(), RESUMABLE_CHUNK_BYTES)) {
        if (params.signal?.aborted) throw new StorageAccountError('上传已取消', 'other');
        let chunkOffset = 0;
        let attempt = 0;
        let noProgress = 0;
        while (chunkOffset < chunk.length) {
          const start = offset;
          const remaining = chunk.subarray(chunkOffset);
          const end = start + remaining.length - 1;
          let response: AxiosResponse<{ id?: string; size?: string }>;
          try {
            response = await axios.put<{ id?: string; size?: string }>(sessionUri, remaining, {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Length': String(remaining.length),
                'Content-Range': `bytes ${start}-${end}/${total}`,
              },
              // 308 = 块已接收继续下一块；200/201 = 完成
              validateStatus: (status) => (status >= 200 && status < 300) || status === 308,
              timeout: 300_000,
              maxBodyLength: Infinity,
              signal: params.signal,
            });
          } catch (error) {
            if (params.signal?.aborted) throw error;
            const status = (error as AxiosError)?.response?.status;
            const retryable = status === undefined || status >= 500 || status === 429;
            attempt += 1;
            if (!retryable || attempt >= CHUNK_RETRY_LIMIT) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            continue;
          }
          if (response.status === 308) {
            // Range 缺失代表该请求尚未确认任何新字节；重复发送当前未确认后缀。
            const rangeHeader = response.headers.range as string | undefined;
            let received = start;
            if (rangeHeader) {
              const match = /^bytes=0-(\d+)$/.exec(rangeHeader.trim());
              if (!match) throw new StorageAccountError('GDrive resumable Range 响应无效', 'other');
              received = Number(match[1]) + 1;
            }
            if (!Number.isSafeInteger(received) || received < start || received > end + 1) {
              throw new StorageAccountError('GDrive resumable Range 偏移越界', 'other');
            }
            if (received === start) {
              noProgress += 1;
              if (noProgress >= CHUNK_RETRY_LIMIT) {
                throw new StorageAccountError('GDrive resumable 上传未确认任何字节', 'other');
              }
              await new Promise((resolve) => setTimeout(resolve, 1000 * noProgress));
              continue;
            }
            const acknowledged = received - start;
            offset = received;
            chunkOffset += acknowledged;
            noProgress = 0;
            attempt = 0;
            continue;
          }
          if (!response.data?.id) {
            throw new StorageAccountError('GDrive resumable 完成响应缺少 fileId', 'other');
          }
          return { objectRef: response.data.id, size: Number(response.data.size ?? total) };
        }
      }
      throw new StorageAccountError('GDrive resumable 流提前结束（字节数不足）', 'other');
    } finally {
      params.signal?.removeEventListener('abort', abortSession);
    }
  }

  /** 把任意流切分为固定大小块（最后一块可短） */
  private async *chunked(stream: Readable, size: number): AsyncGenerator<Buffer> {
    let pending = Buffer.alloc(0);
    for await (const part of stream) {
      pending = Buffer.concat([pending, Buffer.isBuffer(part) ? part : Buffer.from(part)]);
      while (pending.length >= size) {
        yield pending.subarray(0, size);
        pending = pending.subarray(size);
      }
    }
    if (pending.length > 0) yield pending;
  }

  /** 根文件夹：config 回填优先；否则查找/创建 TGTC/（drive.file 下仅本应用可见） */
  private async ensureRootFolder(ctx: StorageAccountContext, token: string): Promise<string> {
    const config = ctx.config as GDriveBackendConfig;
    if (config.rootFolderId) return config.rootFolderId;
    const headers = { Authorization: `Bearer ${token}` };
    const query = await axios.get<{ files?: Array<{ id: string }> }>(`${DRIVE_API}/files`, {
      params: {
        q: `name = '${ROOT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        pageSize: 1,
      },
      headers,
      timeout: 15_000,
    });
    let folderId = query.data?.files?.[0]?.id;
    if (!folderId) {
      const created = await axios.post<{ id: string }>(`${DRIVE_API}/files`, {
        name: ROOT_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }, { headers, timeout: 15_000 });
      folderId = created.data.id;
    }
    // 回填 DB + 内存上下文（best-effort；失败时下次上传重新查找，幂等）
    await this.backends.patchConfig(ctx.accountId, { rootFolderId: folderId });
    (ctx.config as GDriveBackendConfig).rootFolderId = folderId;
    return folderId;
  }

  private async accessToken(ctx: StorageAccountContext): Promise<string> {
    const client = await this.authorizedClient(ctx);
    try {
      const token = await client.getAccessToken();
      if (!token.token) throw new StorageAccountError('GDrive access_token 获取失败', 'auth');
      return token.token;
    } catch (error) {
      throw this.classify(error, 'GDrive 凭据刷新失败');
    }
  }

  private async authorizedClient(ctx: StorageAccountContext): Promise<OAuth2Client> {
    const refreshToken = String(ctx.credential.refreshToken ?? '');
    const oauthConfig = await this.oauth.getClientConfig();
    if (!oauthConfig) throw new StorageAccountError('GDrive OAuth Client 未配置', 'auth');
    const fingerprint = createHash('sha256')
      .update(refreshToken)
      .update('\0')
      .update(oauthConfig.clientId)
      .update('\0')
      .update(oauthConfig.clientSecret)
      .digest('hex')
      .slice(0, 16);
    const cached = this.clients.get(ctx.accountId);
    if (cached && cached.fingerprint === fingerprint) return cached.client;
    const client = await this.oauth.createAuthorizedClient(refreshToken);
    this.clients.set(ctx.accountId, { fingerprint, client });
    return client;
  }

  /** Axios 的 responseType=stream 会把非 2xx 错误体留作 Readable，分类前解析有限大小的 JSON。 */
  private async classifyDownloadError(error: unknown, fallback: string): Promise<StorageAccountError> {
    const response = (error as AxiosError)?.response;
    const body = response?.data;
    if (response && body && typeof (body as Readable).pipe === 'function') {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const rawChunk of body as Readable) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          const remaining = MAX_STREAMED_ERROR_BODY_BYTES - size;
          if (remaining <= 0) break;
          const boundedChunk = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(boundedChunk);
          size += boundedChunk.length;
          if (size >= MAX_STREAMED_ERROR_BODY_BYTES) break;
        }
        response.data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      } catch {
        // Keep status-based classification when the body is empty, malformed, or unreadable.
        response.data = undefined;
      }
    }
    return this.classify(error, fallback);
  }

  /** GDrive 错误分类：优先解析 reason（quota/flood/auth），再按 HTTP 状态码 */
  private classify(error: unknown, fallback: string): StorageAccountError {
    if (error instanceof StorageAccountError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (/invalid_grant/i.test(message)) {
      return new StorageAccountError(`${fallback}（refresh_token 失效，需重新授权）`, 'auth', 401);
    }
    const response = (error as AxiosError)?.response;
    const reasons = ((response?.data as { error?: { errors?: Array<{ reason?: string }> } })?.error?.errors ?? [])
      .map((item) => item.reason ?? '');
    if (reasons.some((reason) => /storageQuotaExceeded/i.test(reason))) {
      return new StorageAccountError(`${fallback}（账号配额已满）`, 'quota', 403);
    }
    if (reasons.some((reason) => /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded/i.test(reason))) {
      return new StorageAccountError(`${fallback}（上游限流）`, 'flood', 403, 60);
    }
    if (typeof response?.status === 'number') {
      const kind = classifyHttpStatus(response.status);
      return new StorageAccountError(`${fallback}（HTTP ${response.status}）`, kind, response.status);
    }
    return toStorageAccountError(error, fallback);
  }
}

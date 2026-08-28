import { Request, Response } from 'express';
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Req,
  Res,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { FileService } from './file.service';
import { ThumbnailCryptoService } from './thumbnail-crypto.service';
import { BatchMarkdownDto, UpdateAccessTypeDto, UpdateAccessCountDto, SetPasswordDto, UpdateExpiresDto } from './file.dto';
import { FolderService } from '../folder/folder.service';
import { MoveFileDto, RenameFileDto, CopyFileDto } from '../folder/folder.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { FileAccessType } from '../common/entities/file.entity';
import { getClientIp } from '../common/utils/client-ip';
import { sanitizePreviewContentType } from '../common/utils/preview-content-type';
import { buildContentDisposition } from '../common/utils/content-disposition';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { StreamResponderService } from '../common/services/stream-responder.service';
import { TagService } from '../tag/tag.service';
import { MediaTicketService } from '../common/services/media-ticket.service';

// Multer 层硬上限（600MB，仅防止极端 DoS；精确的动态限制由 FileService.upload() 业务层负责）
const multerFileSize = 600 * 1024 * 1024; // 600MB

// G2-16：上传端点合理超时（接收阶段）。大文件上传本身耗时较长，设 30 分钟上限，
// 避免恶意/异常慢连接长期占用 worker 与连接资源。
const UPLOAD_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
// G2-16：每用户并发上传数上限（内存计数）。防止单用户并发大量上传挤占带宽与磁盘。
const UPLOAD_USER_CONCURRENCY_LIMIT = 3;
const activeUploadsByUser = new Map<string, number>();

// G2-17/G5-14：匿名媒体 /files/media/:id 的限流与并发上限。
// 保守方案：IP 维度限流（复用 RateLimitService）+ 简单并发连接计数，防刷带宽。
const MEDIA_RATE_LIMIT_PER_SEC = 30;              // 同 IP 每秒最多 30 次媒体请求
const MEDIA_RATE_BAN_MS = 60 * 1000;              // 超限封禁 1 分钟
const MEDIA_CONCURRENCY_PER_IP = 4;               // 同 IP 最大并发媒体连接数
const activeMediaByIp = new Map<string, number>();

// G2-07 修复：Multer 默认 memoryStorage 会把大文件整体驻留内存，多文件并发可 OOM。
// 改为 diskStorage 落盘到临时目录（与分片上传的 incoming 目录同体系），
// 由 FileService 在成功移入业务目录/失败时统一清理（cleanupTempFile / rename）。
const multerUploadDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'incoming');

const multerDiskStorage = diskStorage({
  destination: (_req, _file, callback) => {
    fs.mkdirSync(multerUploadDir, { recursive: true });
    callback(null, multerUploadDir);
  },
  filename: (_req, _file, callback) => callback(null, `${randomUUID()}.part`),
});

@Controller('files')
export class FileController {
  constructor(
    private fileService: FileService,
    private cryptoService: ThumbnailCryptoService,
    private rateLimitService: RateLimitService,
    private configCacheService: ConfigCacheService,
    private streamResponder: StreamResponderService,
    private tagService: TagService,
    private folderService: FolderService,
    private mediaTicketService: MediaTicketService,
  ) {}

  /**
   * G2-16：每用户并发上传限制。简单内存计数：并发达到上限则返回 429，
   * 完成后释放槽位。不跨进程/副本共享（保守方案，避免引入分布式状态）。
   */
  private acquireUploadSlot(userId: string): () => void {
    const current = activeUploadsByUser.get(userId) || 0;
    if (current >= UPLOAD_USER_CONCURRENCY_LIMIT) {
      throw new HttpException('上传并发过多，请等待现有上传完成', HttpStatus.TOO_MANY_REQUESTS);
    }
    activeUploadsByUser.set(userId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activeUploadsByUser.get(userId) || 1) - 1;
      if (remaining > 0) activeUploadsByUser.set(userId, remaining);
      else activeUploadsByUser.delete(userId);
    };
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { storage: multerDiskStorage, limits: { fileSize: multerFileSize } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    // G2-16：大文件接收阶段设置合理超时 + 每用户并发上传数限制
    applyUploadTimeout(req, res);
    const release = this.acquireUploadSlot(user.id);
    try {
      if (!file) {
        throw new BadRequestException('请选择要上传的文件');
      }
      const tagIds = parseTagIdsBody(tagIdsRaw);
      if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
      return await this.fileService.upload(file, user, tagIds);
    } finally {
      release();
    }
  }

  @Post('upload-multiple')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10, { storage: multerDiskStorage, limits: { fileSize: multerFileSize } }))
  async uploadMultiple(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    // G2-16：大文件接收阶段设置合理超时 + 每用户并发上传数限制
    applyUploadTimeout(req, res);
    const release = this.acquireUploadSlot(user.id);
    try {
      if (!files || files.length === 0) {
        throw new BadRequestException('请选择要上传的文件');
      }
      const tagIds = parseTagIdsBody(tagIdsRaw);
      if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
      return await this.fileService.uploadMultiple(files, user, tagIds);
    } finally {
      release();
    }
  }

  /**
   * 异步上传（推荐用于大文件，防止 Cloudflare 代理超时）
   * 文件接收后立即返回 jobId，后台处理 Telegram 上传。
   * 前端通过 GET /api/files/upload-status/:jobId 轮询结果。
   */
  @Post('upload-async')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { storage: multerDiskStorage, limits: { fileSize: multerFileSize } }))
  async uploadAsync(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
    @Body('folderId') folderId?: string,
    @Body('overwriteFileId') overwriteFileId?: string,
  ) {
    // G2-16：接收阶段设置合理超时 + 每用户并发上传数限制
    applyUploadTimeout(req, res);
    const release = this.acquireUploadSlot(user.id);
    try {
      if (!file) {
        throw new BadRequestException('请选择要上传的文件');
      }
      const tagIds = parseTagIdsBody(tagIdsRaw);
      if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
      // overwriteFileId 仅接受 UUID v4 格式，其余非法值直接拒绝（避免透传垃圾值）
      const normalizedOverwriteFileId = normalizeOptionalUuid(overwriteFileId);
      return await this.fileService.uploadAsync(file, user, tagIds, req, folderId || null, normalizedOverwriteFileId);
    } finally {
      release();
    }
  }

  /**
   * 异步批量上传
   */
  @Post('upload-multiple-async')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10, { storage: multerDiskStorage, limits: { fileSize: multerFileSize } }))
  async uploadMultipleAsync(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    // G2-16：接收阶段设置合理超时 + 每用户并发上传数限制
    applyUploadTimeout(req, res);
    const release = this.acquireUploadSlot(user.id);
    try {
      if (!files || files.length === 0) {
        throw new BadRequestException('请选择要上传的文件');
      }
      const tagIds = parseTagIdsBody(tagIdsRaw);
      if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
      return await this.fileService.uploadMultipleAsync(files, user, tagIds, req);
    } finally {
      release();
    }
  }

  /**
   * 查询异步上传任务状态
   */
  @Get('upload-status/:jobId')
  @UseGuards(JwtAuthGuard)
  async getUploadStatus(@Param('jobId') jobId: string, @CurrentUser() user: User) {
    const job = this.fileService.getUploadJob(jobId);
    if (!job) {
      throw new BadRequestException('任务不存在或已过期');
    }
    // 仅允许任务创建者查询
    if (job.userId !== user.id && user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new BadRequestException('无权访问此任务');
    }
    // 只返回必要字段
    const { userId: _, ...jobInfo } = job;
    return jobInfo;
  }

  @Get('upload-config')
  async getUploadConfig() {
    const maxFileSize = await this.fileService.getMaxFileSize();
    const typeConfig = await this.fileService.getFileTypeConfig();
    return { maxFileSize, ...typeConfig };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @CurrentUser() user: User,
    @Query('userId') userId?: string,
    @Query('keyword') keyword?: string,
    @Query('includeDeleted') includeDeleted?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('cursor') cursor?: string,
    @Query('tagIds') tagIdsRaw?: string,
    @Query('folderId') folderId?: string,
    @Req() req?: Request,
  ) {
    // 关键词长度限制：最大 100 字符，防止极端搜索词滥用
    if (keyword && keyword.length > 100) {
      throw new BadRequestException('搜索关键词不能超过 100 个字符');
    }
    // 搜索频率限流：IP 维度（使用安全配置中的阈值，不存在时默认 30 次/分钟）
    if (keyword) {
      const clientIp = getClientIp(req!);
      const searchRateLimit = Number(await this.configCacheService.get('sec_search_rate_limit', '30')) || 30;
      const rateResult = await this.rateLimitService.checkAndIncrement(
        `search:${clientIp}`,
        'file_search',
        searchRateLimit,
        1 * 60 * 1000,
        60 * 1000,
      );
      if (!rateResult.allowed) {
        throw new HttpException('搜索过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    const shouldIncludeDeleted = includeDeleted === 'true';
    const tagIds = tagIdsRaw ? tagIdsRaw.split(',').filter(Boolean) : undefined;

    // 校验标签所有权
    if (tagIds?.length) {
      await this.tagService.assertOwner(user.id, tagIds);
    }

    // Non-admin users can only see their own files
    if (user.role === UserRole.USER) {
      return this.fileService.findAll(Number(page), Number(limit), user.id, keyword, shouldIncludeDeleted, sortBy, sortOrder, cursor, tagIds, folderId);
    }
    // Admin: only show all files when userId filter is explicitly provided;
    // default to own files for the "我的文件" page
    return this.fileService.findAll(Number(page), Number(limit), userId || user.id, keyword, shouldIncludeDeleted, sortBy, sortOrder, cursor, tagIds, folderId);
  }

  /**
   * 获取缩略图加密公钥（每次服务重启自动生成新密钥对）
   */
  @Get('public-key')
  getPublicKey() {
    return { publicKey: this.cryptoService.getPublicKey() };
  }

  /**
   * 公开媒体直链：直接返回图片、音频或视频本体，供图床、Markdown 和媒体标签引用。
   * 仅允许无密码、无次数/时效限制的公开媒体文件。
   */
  @Get('media/:id')
  async getPublicMedia(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const clientIp = getClientIp(req);
      // G2-17/G5-14：匿名媒体端点限流 —— 同 IP 速率限制 + 并发连接数上限（防刷带宽/击穿）
      const rateResult = await this.rateLimitService.checkAndIncrement(
        `media:${clientIp}`,
        'media',
        MEDIA_RATE_LIMIT_PER_SEC,
        MEDIA_RATE_BAN_MS,
        1000,
      );
      if (!rateResult.allowed) {
        throw new HttpException('媒体访问过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
      }
      const currentConcurrency = activeMediaByIp.get(clientIp) || 0;
      if (currentConcurrency >= MEDIA_CONCURRENCY_PER_IP) {
        throw new HttpException('媒体并发连接过多，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
      }
      activeMediaByIp.set(clientIp, currentConcurrency + 1);
      const releaseMediaSlot = () => {
        const remaining = (activeMediaByIp.get(clientIp) || 1) - 1;
        if (remaining > 0) activeMediaByIp.set(clientIp, remaining);
        else activeMediaByIp.delete(clientIp);
      };
      // 流响应结束/客户端断开时释放并发槽位
      res.on('close', releaseMediaSlot);
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const rangeResult = await this.fileService.getPublicMediaStreamWithRange(id, rangeHeader, clientIp, typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined);
        if (rangeResult) {
          await this.streamResponder.send({
            res,
            status: 206,
            range: rangeResult,
            headers: {
              'Content-Type': rangeResult.contentType,
              'Content-Disposition': buildContentDisposition('inline', rangeResult.filename),
              'Content-Length': rangeResult.size.toString(),
              ETag: rangeResult.etag || '"0"',
              'Accept-Ranges': 'bytes',
              // C-01/H-03 修复：公开媒体是权限可变资源（可删除/转私有/加约束），
              // 不保留长 TTL 公开缓存；并强制 nosniff + no-referrer + 限制性 CSP 纵深防御。
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer',
              'Content-Security-Policy': "default-src 'none'; sandbox",
            },
            stream: rangeResult.stream,
            accessLogId: rangeResult.accessLogId,
            updateAccessLog: (id, bytes) => this.fileService.updateAccessLogResponseSize(id, bytes),
          });
          return;
        }
      }

      const result = await this.fileService.getPublicMediaStream(id, clientIp);
      await this.streamResponder.send({
        res,
        headers: {
          'Content-Type': result.contentType,
          'Content-Disposition': buildContentDisposition('inline', result.filename),
          'Content-Length': result.size.toString(),
          ETag: result.etag,
          'Accept-Ranges': 'bytes',
          // C-01/H-03 修复：同 206 分支，禁止长 TTL 缓存与凭据外泄。
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
        stream: result.stream,
        accessLogId: result.accessLogId,
        updateAccessLog: (id, bytes) => this.fileService.updateAccessLogResponseSize(id, bytes),
      });
    } catch (error) {
      this.streamResponder.handleError(res, error, '媒体文件访问失败', req);
    }
  }

  /** 签发仅供 URL 媒体预览使用的短期票据，绝不将登录 JWT 写入 URL。 */
  @Post(':id/media-ticket')
  @UseGuards(JwtAuthGuard)
  async issueMediaTicket(@Param('id') id: string, @CurrentUser() user: User) {
    const file = await this.fileService.findOne(id, user);
    return {
      ticket: this.mediaTicketService.issue({
        fileId: file.id,
        uploadVersion: file.uploadVersion,
        subject: user.id,
        scope: 'user',
        purpose: 'preview',
      }),
      expiresIn: 300,
    };
  }

  /** 匿名媒体取流端点：票据和文件版本/当前权限均须通过校验。 */
  @Get('media-ticket')
  async previewWithMediaTicket(@Query('ticket') ticket: string, @Req() req: Request, @Res() res: Response) {
    try {
      const payload = this.mediaTicketService.verify(ticket);
      if (payload.scope !== 'user' || payload.purpose !== 'preview') {
        throw new BadRequestException('媒体票据用途不匹配');
      }
      await this.fileService.assertMediaTicketUserReadable(payload.fileId, payload.uploadVersion, payload.subject);
      const ticketUser = { id: payload.subject, role: UserRole.USER } as User;
      const rangeHeader = req.headers.range;
      const rangeResult = rangeHeader
        ? await this.fileService.getPreviewStreamWithRange(payload.fileId, ticketUser, rangeHeader, getClientIp(req), typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined, payload.uploadVersion)
        : null;
      const result = rangeResult || await this.fileService.getPreviewStream(payload.fileId, ticketUser, getClientIp(req), payload.uploadVersion);
      const isRange = !!rangeResult;
      await this.streamResponder.send({
        res,
        status: isRange ? 206 : undefined,
        range: isRange ? rangeResult! : undefined,
        headers: {
          'Content-Type': sanitizePreviewContentType(result.contentType),
          'Content-Disposition': buildContentDisposition('inline', result.filename),
          'Content-Length': result.size.toString(),
          ETag: result.etag || '"0"',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
        stream: result.stream,
        accessLogId: result.accessLogId,
        updateAccessLog: (accessLogId, bytes) => this.fileService.updateAccessLogResponseSize(accessLogId, bytes),
      });
    } catch (error) {
      this.streamResponder.handleError(res, error, '媒体票据预览失败', req);
    }
  }

  /**
   * inline 预览端点：流式返回文件内容供页内预览。
   * - 预览不消耗访问次数（不递增 currentAccessCount），access log action 为 'preview'
   * - 不套用下载限流
   * - 支持 Range：本地缓存命中返回 206，未命中回退 200 全量
   * - 防 XSS：html/svg+xml/xml 类型强制降级为 text/plain（配合 nosniff）
   */
  @Get(':id/preview')
  @UseGuards(JwtAuthGuard)
  async preview(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const clientIp = getClientIp(req);

      // Range 请求支持（仅缓存命中时可用）
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const rangeResult = await this.fileService.getPreviewStreamWithRange(
          id,
          user,
          rangeHeader,
          clientIp,
          typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
        );
        if (rangeResult) {
          await this.streamResponder.send({
            res,
            status: 206,
            range: rangeResult,
            headers: {
              'Content-Type': sanitizePreviewContentType(rangeResult.contentType),
              'Content-Disposition': buildContentDisposition('inline', rangeResult.filename),
              'Content-Length': rangeResult.size.toString(),
              ETag: rangeResult.etag || '"0"',
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, no-cache',
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer',
            },
            stream: rangeResult.stream,
            accessLogId: rangeResult.accessLogId,
            updateAccessLog: (id, bytes) => this.fileService.updateAccessLogResponseSize(id, bytes),
          });
          return;
        }
        }

      const result = await this.fileService.getPreviewStream(id, user, clientIp);

      await this.streamResponder.send({
        res,
        headers: {
          'Content-Type': sanitizePreviewContentType(result.contentType),
          'Content-Disposition': buildContentDisposition('inline', result.filename),
          'Content-Length': result.size.toString(),
          ETag: result.etag,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
        stream: result.stream,
        accessLogId: result.accessLogId,
        updateAccessLog: (id, bytes) => this.fileService.updateAccessLogResponseSize(id, bytes),
      });
    } catch (error) {
      this.streamResponder.handleError(res, error, '预览失败', req);
    }
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.fileService.findOne(id, user);
  }

  /**
   * 缩略图预览端点
   * - 需要登录认证 + 加密时间戳（?t=）
   * - 时间戳需用公钥 RSA-OAEP 加密，误差 ±10 秒内有效
   * - 只能访问自己上传的文件（管理员除外）
   * - 不受私有/加密/次数/过期限制
   */
  @Get(':id/thumbnail')
  @UseGuards(JwtAuthGuard)
  async thumbnail(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    try {
      // G4-10：移除可自铸/重放的 RSA 时间戳令牌层。
      // 该端点已由 JwtAuthGuard + getThumbnailStream(id, user) 完成鉴权与文件级授权，
      // 公钥加密时间戳不绑定 fileId/userId，人人可自铸，属冗余层；直接移除校验。
      // 前端旧逻辑仍会携带 ?t=，服务端忽略该参数（向后兼容）。
      const result = await this.fileService.getThumbnailStream(id, user);

      res.set({
        'Content-Type': result.contentType,
        'Cache-Control': 'private, no-cache',
      });

      const pipe = promisify(pipeline);
      result.stream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      await pipe(result.stream, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : '预览失败';
      const status = (error as { status?: number }).status || 500;
      if (!res.headersSent) {
        res.status(status).json({ code: status, message, data: null });
      }
    }
  }

  /**
   * 高清视频封面端点（与缩略图同一套加密时间戳 Token 机制）。
   * - 需要登录认证 + 加密时间戳（?t=）
   * - 只从本地正式缓存生成高清封面，不因封面请求触发整视频回源
   * - 高清封面不可用时回退标准封面；完全不可用返回 404
   */
  @Get(':id/thumbnail-hd')
  @UseGuards(JwtAuthGuard)
  async thumbnailHd(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    try {
      // G4-10：同 thumbnail，移除可自铸/重放的 RSA 时间戳令牌层，依赖 JWT 鉴权。
      const result = await this.fileService.getHdThumbnailStream(id, user);

      res.set({
        'Content-Type': result.contentType,
        'Cache-Control': 'private, no-cache',
      });

      const pipe = promisify(pipeline);
      result.stream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      await pipe(result.stream, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : '预览失败';
      const status = (error as { status?: number }).status || 500;
      if (!res.headersSent) {
        res.status(status).json({ code: status, message, data: null });
      }
    }
  }

  /**
   * 查询文件缓存状态端点（登录态）。
   * 供前端在视频预览前判断冷资源单连接策略。
   */
  @Get(':id/cache-status')
  @UseGuards(JwtAuthGuard)
  async cacheStatus(@Param('id') id: string, @CurrentUser() user: User) {
    return this.fileService.getCacheStatus(id, user);
  }

  @Get(':id/download')
  @UseGuards(JwtAuthGuard)
  async download(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      // 下载限流：从安全配置动态读取阈值（热更新，无需重启）
      // 键用 user+ip 组合，避免共享出口 IP 下其他用户被牵连限流
      const clientIp = getClientIp(req);
      const downloadRateLimit = Number(await this.configCacheService.get('sec_download_rate_limit', '10')) || 10;
      const downloadRateWindow = Number(await this.configCacheService.get('sec_download_rate_window', '60')) || 60;
      const downloadRateBan = Number(await this.configCacheService.get('sec_download_rate_ban', '1')) || 1;
      const rateLimitResult = await this.rateLimitService.checkAndIncrement(
        `download:${user.id}:${clientIp}`,
        'download',
        downloadRateLimit,                     // maxAttempts
        downloadRateBan * 60 * 1000,           // lockDurationMs
        downloadRateWindow * 1000,             // windowMs
      );

      if (!rateLimitResult.allowed) {
        throw new HttpException(
          `下载过于频繁，请在 ${rateLimitResult.waitMinutes || downloadRateBan} 分钟后重试`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 请求级无缓存：仅管理员可通过 ?nocache=1|true 强制实时回源直通，普通用户传参忽略
      const isAdmin = user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
      const noCacheRequested = isAdmin && (req.query.nocache === '1' || req.query.nocache === 'true');

      // Range 请求支持（仅缓存命中时可用）
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const rangeResult = await this.fileService.getFileContentStreamWithRange(
          id, user, rangeHeader,
          { noCache: noCacheRequested ? true : undefined, ip: clientIp, ifRange: typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined as string | undefined },
        );
        if (rangeResult) {
          await this.streamResponder.send({
            res,
            status: 206,
            range: rangeResult,
            headers: {
              'Content-Type': rangeResult.contentType,
              'Content-Disposition': buildContentDisposition('attachment', rangeResult.filename),
              'Content-Length': rangeResult.size.toString(),
              ETag: rangeResult.etag || '"0"',
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, no-cache',
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer',
            },
            stream: rangeResult.stream,
            accessLogId: rangeResult.accessLogId,
            updateAccessLog: (id, bytes) => this.fileService.updateAccessLogResponseSize(id, bytes),
          });
          return;
        }
        // Range 不支持（未缓存）→ 回退完整下载
      }

      const result = await this.fileService.getFileContentStream(
        id, user, clientIp,
        noCacheRequested ? { noCache: true } : undefined,
      );

      await this.streamResponder.send({
        res,
        headers: {
          'Content-Type': result.contentType,
          'Content-Disposition': buildContentDisposition('attachment', result.filename),
          'Content-Length': result.size.toString(),
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
        stream: result.stream,
        accessLogId: result.accessLogId,
        updateAccessLog: (id, bytes) => this.fileService.updateAccessLogResponseSize(id, bytes),
      });
    } catch (error) {
      this.streamResponder.handleError(res, error, '下载失败', req);
    }
  }

  @Put(':id/access-type')
  @UseGuards(JwtAuthGuard)
  async updateAccessType(
    @Param('id') id: string,
    @Body() data: UpdateAccessTypeDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateAccessType(id, data.accessType as FileAccessType, user);
    return { message: '访问权限已更新' };
  }

  @Put(':id/access-count')
  @UseGuards(JwtAuthGuard)
  async updateAccessCount(
    @Param('id') id: string,
    @Body() data: UpdateAccessCountDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateAccessCount(id, data.maxAccessCount, user);
    return { message: '访问次数限制已更新' };
  }

  @Put(':id/password')
  @UseGuards(JwtAuthGuard)
  async setPassword(
    @Param('id') id: string,
    @Body() data: SetPasswordDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.setPassword(id, data.password, user);
    return { message: '密码已设置' };
  }

  @Put(':id/expires')
  @UseGuards(JwtAuthGuard)
  async updateExpires(
    @Param('id') id: string,
    @Body() data: UpdateExpiresDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateExpires(id, data.expiresIn, user);
    return { message: '有效期已更新' };
  }

  /**
   * 移动文件到指定文件夹（网盘功能）。
   * Body: { folderId: string | null }
   *   - folderId = null：移动到网盘根目录
   *   - folderId = <uuid>：移动到指定文件夹（必须是当前用户拥有的文件夹）
   */
  @Patch(':id/move')
  @UseGuards(JwtAuthGuard)
  async moveFile(
    @Param('id') id: string,
    @Body() dto: MoveFileDto,
    @CurrentUser() user: User,
  ) {
    const file = await this.folderService.moveFile(user.id, id, dto);
    return { id: file.id, folderId: file.folderId };
  }

  /**
   * 重命名文件显示名。
   * Body: { newOriginalName: string }
   */
  @Patch(':id/rename')
  @UseGuards(JwtAuthGuard)
  async renameFile(
    @Param('id') id: string,
    @Body() dto: RenameFileDto,
    @CurrentUser() user: User,
  ) {
    const file = await this.folderService.renameFile(user.id, id, dto);
    return { id: file.id, originalName: file.originalName };
  }

  /**
   * 复制文件（在目标文件夹生成独立副本）。
   * Body: { folderId: string | null }（null 表示复制到根目录）
   */
  @Post(':id/copy')
  @UseGuards(JwtAuthGuard)
  async copyFile(
    @Param('id') id: string,
    @Body() dto: CopyFileDto,
    @CurrentUser() user: User,
  ) {
    return this.folderService.copyFile(user.id, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async delete(@Param('id') id: string, @CurrentUser() user: User) {
    return this.fileService.delete(id, user);
  }

  @Post(':id/restore')
  @UseGuards(JwtAuthGuard)
  async restoreDelete(@Param('id') id: string, @CurrentUser() user: User) {
    await this.fileService.restoreDelete(id, user);
    return { message: '文件已恢复' };
  }

  /** 文件主强制永久删除自己的文件（跳过 7 天等待期） */
  @Post(':id/force-delete')
  @UseGuards(JwtAuthGuard)
  async forceDelete(@Param('id') id: string, @CurrentUser() user: User) {
    await this.fileService.forceDelete(id, user);
    return { message: '文件已永久删除' };
  }

  @Post('batch-markdown')
  @UseGuards(JwtAuthGuard)
  async batchToMarkdown(
    @Body() data: BatchMarkdownDto,
    @CurrentUser() user: User,
  ) {
    const markdown = await this.fileService.batchToMarkdown(data.ids, user);
    return { markdown };
  }

  /** 设置文件标签（全量替换） */
  @Put(':id/tags')
  @UseGuards(JwtAuthGuard)
  async setFileTags(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body('tagIds') tagIds: string[],
  ) {
    if (!Array.isArray(tagIds)) {
      throw new BadRequestException('tagIds 必须是数组');
    }
    // 校验标签所有权
    if (tagIds.length > 0) {
      await this.tagService.assertOwner(user.id, tagIds);
    }
    await this.fileService.setFileTags(id, user, tagIds);
    return { message: '标签已更新' };
  }

  /** 移除文件单个标签 */
  @Delete(':id/tags/:tagId')
  @UseGuards(JwtAuthGuard)
  async removeFileTag(
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @CurrentUser() user: User,
  ) {
    await this.fileService.removeFileTag(id, user, tagId);
    return { message: '标签已移除' };
  }

  /**
   * 老分享链接入口 /files/public/:id —— Phase 2 重构为 302 重定向到 /s/:id。
   *
   * Phase 2 之前此端点负责：
   *   1. 流式返回无约束公开文件
   *   2. 服务端渲染 HTML 密码页
   *   3. 302 跳转到短效 access token URL
   *
   * Phase 2 起，所有分享逻辑统一由 ShareLink + SPA 路由 /s/:token 处理。
   * 此端点改为「懒创建 + 重定向」：
   *   - 查找文件，校验存在 + 公开
   *   - 查找 ShareLink（token = file.id），不存在则自动创建（公开无密码）
   *   - 302 重定向到 /s/{id}
   *
   * 这确保迁移后新上传的公开文件也能通过老 URL /files/public/{id} 访问。
   */
  @Get('public/:id')
  async getPublicFile(
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

    // 校验 + 懒创建 ShareLink 的逻辑已下沉到 FileService（Controller 不再直接访问 Repository）
    try {
      await this.fileService.ensureLegacyPublicShare(id);
    } catch (error) {
      const status = (error as { status?: number }).status || 500;
      const message = (error as Error).message || '文件不存在';
      if (!res.headersSent) {
        res.status(status).json({ code: status, message, data: null });
      }
      return;
    }

    // 4. 重定向到 SPA 分享页
    res.redirect(302, `/s/${id}`);
  }

  // Generate share link
  @Get(':id/share')
  @UseGuards(JwtAuthGuard)
  async generateShareLink(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    const link = await this.fileService.generateShareLink(id, user);
    return { link };
  }
}


/**
 * G2-16：为上传请求设置接收阶段的合理超时。
 * 相比原先的 req.setTimeout(0) 无限期挂起，这里设 30 分钟上限，
 * 慢连接不会长期占用 worker 与连接资源。
 */
function applyUploadTimeout(req: Request, res: Response): void {
  req.setTimeout(UPLOAD_REQUEST_TIMEOUT_MS);
  res.setTimeout(UPLOAD_REQUEST_TIMEOUT_MS);
}

/** 解析请求体中的 tagIds 字段，支持字符串和数组格式 */
function parseTagIdsBody(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').filter(Boolean);
  return undefined;
}

/**
 * FormData 可选字段 overwriteFileId 归一化：缺省返回 undefined；
 * 非 UUID v4 格式直接 400（与分片 init 的 DTO 校验语义一致）。
 */
function normalizeOptionalUuid(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new BadRequestException('overwriteFileId 必须是合法的 UUID v4');
  }
  return raw;
}



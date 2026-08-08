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
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { FileService, RangeNotSatisfiableException } from './file.service';
import { ThumbnailCryptoService } from './thumbnail-crypto.service';
import { BatchMarkdownDto, UpdateAccessTypeDto, UpdateAccessCountDto, SetPasswordDto, UpdateExpiresDto } from './file.dto';
import { FolderService } from '../folder/folder.service';
import { MoveFileDto, RenameFileDto, CopyFileDto } from '../folder/folder.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { FileAccessType } from '../common/entities/file.entity';
import { getClientIp } from '../common/utils/client-ip';
import { sanitizePreviewContentType } from '../common/utils/preview-content-type';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { TagService } from '../tag/tag.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShareLink, ShareLinkStatus, ShareTargetType } from '../common/entities/share-link.entity';
import { File as FileEntity } from '../common/entities/file.entity';

// Multer 层硬上限（600MB，仅防止极端 DoS；精确的动态限制由 FileService.upload() 业务层负责）
const multerFileSize = 600 * 1024 * 1024; // 600MB

/**
 * 记录 pipeline 前的已发送字节数，返回一个用于 pipeline 完成后更新日志的闭包。
 * 与 access-log.middleware.ts 使用相同的 socket.bytesWritten 差值原理。
 */
function trackBytesSent(res: Response): () => number {
  const startBytes = res.socket?.bytesWritten ?? 0;
  return () => (res.socket?.bytesWritten ?? 0) - startBytes;
}

@Controller('files')
export class FileController {
  constructor(
    private fileService: FileService,
    private cryptoService: ThumbnailCryptoService,
    private rateLimitService: RateLimitService,
    private configCacheService: ConfigCacheService,
    private tagService: TagService,
    private folderService: FolderService,
    @InjectRepository(ShareLink)
    private shareLinkRepository: Repository<ShareLink>,
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
  ) {}

  @Post('upload')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: multerFileSize } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    // 大文件上传：禁用请求和响应超时，防止上传/转发过程中连接被断开
    req.setTimeout(0);
    res.setTimeout(0);
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }
    const tagIds = parseTagIdsBody(tagIdsRaw);
    if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
    return this.fileService.upload(file, user, tagIds);
  }

  @Post('upload-multiple')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: multerFileSize } }))
  async uploadMultiple(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    // 大文件上传：禁用超时（仅接收阶段）
    req.setTimeout(0);
    res.setTimeout(0);
    if (!files || files.length === 0) {
      throw new BadRequestException('请选择要上传的文件');
    }
    const tagIds = parseTagIdsBody(tagIdsRaw);
    if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
    return this.fileService.uploadMultiple(files, user, tagIds);
  }

  /**
   * 异步上传（推荐用于大文件，防止 Cloudflare 代理超时）
   * 文件接收后立即返回 jobId，后台处理 Telegram 上传。
   * 前端通过 GET /api/files/upload-status/:jobId 轮询结果。
   */
  @Post('upload-async')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: multerFileSize } }))
  async uploadAsync(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
    @Body('folderId') folderId?: string,
    @Body('overwriteFileId') overwriteFileId?: string,
  ) {
    req.setTimeout(0);
    res.setTimeout(0);
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }
    const tagIds = parseTagIdsBody(tagIdsRaw);
    if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
    // overwriteFileId 仅接受 UUID v4 格式，其余非法值直接拒绝（避免透传垃圾值）
    const normalizedOverwriteFileId = normalizeOptionalUuid(overwriteFileId);
    return this.fileService.uploadAsync(file, user, tagIds, req, folderId || null, normalizedOverwriteFileId);
  }

  /**
   * 异步批量上传
   */
  @Post('upload-multiple-async')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: multerFileSize } }))
  async uploadMultipleAsync(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    req.setTimeout(0);
    res.setTimeout(0);
    if (!files || files.length === 0) {
      throw new BadRequestException('请选择要上传的文件');
    }
    const tagIds = parseTagIdsBody(tagIdsRaw);
    if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
    return this.fileService.uploadMultipleAsync(files, user, tagIds, req);
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
      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const rangeResult = await this.fileService.getPublicMediaStreamWithRange(id, rangeHeader, clientIp);
        if (rangeResult) {
          res.status(206);
          res.set({
            'Content-Type': rangeResult.contentType,
            'Content-Disposition': `inline; filename="${encodeURIComponent(rangeResult.filename)}"`,
            'Content-Length': rangeResult.size.toString(),
            'Content-Range': `bytes ${rangeResult.start}-${rangeResult.end}/${rangeResult.total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
            'X-Content-Type-Options': 'nosniff',
          });
          const getBytesSent = trackBytesSent(res);
          const pipe = promisify(pipeline);
          try {
            await pipe(rangeResult.stream, res);
          } finally {
            if (rangeResult.accessLogId) {
              await this.fileService.updateAccessLogResponseSize(rangeResult.accessLogId, getBytesSent());
            }
          }
          return;
        }
      }

      const result = await this.fileService.getPublicMediaStream(id, clientIp);
      res.set({
        'Content-Type': result.contentType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(result.filename)}"`,
        'Content-Length': result.size.toString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      const getBytesSent = trackBytesSent(res);
      const pipe = promisify(pipeline);
      try {
        await pipe(result.stream, res);
      } finally {
        if (result.accessLogId) {
          await this.fileService.updateAccessLogResponseSize(result.accessLogId, getBytesSent());
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '媒体文件访问失败';
      const status = (error as { status?: number }).status || 500;
      if (!res.headersSent) {
        if (error instanceof RangeNotSatisfiableException) {
          res.set('Content-Range', `bytes */${error.total}`);
        }
        res.status(status).json({ code: 1, message });
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error(message));
      }
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
        const rangeResult = await this.fileService.getPreviewStreamWithRange(id, user, rangeHeader, clientIp);
        if (rangeResult) {
          res.status(206);
          res.set({
            'Content-Type': sanitizePreviewContentType(rangeResult.contentType),
            'Content-Disposition': `inline; filename="${encodeURIComponent(rangeResult.filename)}"`,
            'Content-Length': rangeResult.size.toString(),
            'Content-Range': `bytes ${rangeResult.start}-${rangeResult.end}/${rangeResult.total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-cache',
            'X-Content-Type-Options': 'nosniff',
          });
          const getBytesSent = trackBytesSent(res);
          const pipe = promisify(pipeline);
          try {
            await pipe(rangeResult.stream, res);
          } finally {
            if (rangeResult.accessLogId) {
              await this.fileService.updateAccessLogResponseSize(rangeResult.accessLogId, getBytesSent());
            }
          }
          return;
        }
        // Range 不支持（未缓存）→ 回退全量预览
      }

      const result = await this.fileService.getPreviewStream(id, user, clientIp);

      res.set({
        'Content-Type': sanitizePreviewContentType(result.contentType),
        'Content-Disposition': `inline; filename="${encodeURIComponent(result.filename)}"`,
        'Content-Length': result.size.toString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      });

      const getBytesSent = trackBytesSent(res);
      const pipe = promisify(pipeline);
      try {
        await pipe(result.stream, res);
      } finally {
        if (result.accessLogId) {
          await this.fileService.updateAccessLogResponseSize(result.accessLogId, getBytesSent());
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '预览失败';
      const status = (error as { status?: number }).status || 500;
      if (!res.headersSent) {
        if (error instanceof RangeNotSatisfiableException) {
          res.set('Content-Range', `bytes */${error.total}`);
        }
        res.status(status).json({ code: 1, message });
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error(message));
      }
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
    @Query('t') encryptedToken: string,
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    try {
      if (!encryptedToken) {
        throw new ForbiddenException('缺少访问令牌');
      }

      let timestamp: number;
      try {
        timestamp = this.cryptoService.decrypt(encryptedToken);
      } catch {
        throw new ForbiddenException('无效的访问令牌');
      }

      if (Math.abs(Date.now() - timestamp) > 10_000) {
        throw new ForbiddenException('访问令牌已过期');
      }

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
        res.status(status).json({ code: 1, message });
      }
    }
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
          noCacheRequested ? { noCache: true } : undefined,
        );
        if (rangeResult) {
          res.status(206);
          res.set({
            'Content-Type': rangeResult.contentType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(rangeResult.filename)}"`,
            'Content-Length': rangeResult.size.toString(),
            'Content-Range': `bytes ${rangeResult.start}-${rangeResult.end}/${rangeResult.total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-cache',
          });
          const getBytesSent = trackBytesSent(res);
          const pipe = promisify(pipeline);
          try {
            await pipe(rangeResult.stream, res);
          } finally {
            if (rangeResult.accessLogId) {
              await this.fileService.updateAccessLogResponseSize(rangeResult.accessLogId, getBytesSent());
            }
          }
          return;
        }
        // Range 不支持（未缓存）→ 回退完整下载
      }

      const result = await this.fileService.getFileContentStream(
        id, user, clientIp,
        noCacheRequested ? { noCache: true } : undefined,
      );

      res.set({
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
        'Content-Length': result.size.toString(),
        'Cache-Control': 'private, no-cache',
      });

      const getBytesSent = trackBytesSent(res);
      const pipe = promisify(pipeline);
      try {
        await pipe(result.stream, res);
      } finally {
        if (result.accessLogId) {
          await this.fileService.updateAccessLogResponseSize(result.accessLogId, getBytesSent());
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败';
      const status = (error as { status?: number }).status || 500;
      if (!res.headersSent) {
        if (error instanceof RangeNotSatisfiableException) {
          res.set('Content-Range', `bytes */${error.total}`);
        }
        res.status(status).json({ code: 1, message });
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error(message));
      }
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

    // 1. 查找文件，校验存在且未删除（select 包含遗留约束字段，用于懒创建 ShareLink）
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['id', 'accessType', 'uploaderId', 'originalName', 'password', 'maxAccessCount', 'expiresIn', 'expiresStartAt'],
    });
    if (!file) {
      res.status(404).json({ code: 1, message: '文件不存在' });
      return;
    }

    // 2. 私有文件不允许公开访问
    if (file.accessType !== FileAccessType.PUBLIC) {
      res.status(403).json({ code: 1, message: '此文件为私有文件，不提供公开访问' });
      return;
    }

    // 3. 懒创建 ShareLink（如果不存在）——复制文件的遗留约束字段
    let shareLink = await this.shareLinkRepository.findOne({
      where: { token: id, isDeleted: false },
    });
    if (!shareLink) {
      shareLink = this.shareLinkRepository.create({
        token: id, // 用文件 id 作为 token，确保老链接兼容
        targetType: ShareTargetType.FILE,
        targetId: id,
        creatorId: file.uploaderId,
        // 复制文件的遗留约束（Phase 2 之前通过 /files/:id/password 等端点设置的）
        password: file.password ?? null,
        maxAccessCount: file.maxAccessCount ?? -1,
        expiresIn: file.expiresIn ?? null,
        expiresStartAt: file.expiresStartAt ?? null,
        status: ShareLinkStatus.ACTIVE,
      });
      try {
        await this.shareLinkRepository.save(shareLink);
      } catch {
        // 并发创建时可能触发唯一约束冲突，忽略——另一个请求已创建
        shareLink = await this.shareLinkRepository.findOne({
          where: { token: id, isDeleted: false },
        });
      }
    }

    // 重校：并发创建/即时取消等边界下 shareLink 仍可能为空，避免带着空链接重定向
    if (!shareLink) {
      res.status(404).json({ code: 1, message: '分享不存在或已被取消' });
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



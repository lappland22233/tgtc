import { Request, Response } from 'express';
import {
  Controller,
  Get,
  Post,
  Put,
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
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { FileService } from './file.service';
import { ThumbnailCryptoService } from './thumbnail-crypto.service';
import { BatchMarkdownDto, UpdateAccessTypeDto, UpdateAccessCountDto, SetPasswordDto, UpdateExpiresDto } from './file.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { FileAccessType } from '../common/entities/file.entity';
import { getClientIp } from '../common/utils/client-ip';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { TagService } from '../tag/tag.service';

// Multer 层硬上限（600MB，仅防止极端 DoS；精确的动态限制由 FileService.upload() 业务层负责）
const multerFileSize = 600 * 1024 * 1024; // 600MB

@Controller('files')
export class FileController {
  constructor(
    private fileService: FileService,
    private configService: ConfigService,
    private cryptoService: ThumbnailCryptoService,
    private rateLimitService: RateLimitService,
    private configCacheService: ConfigCacheService,
    private tagService: TagService,
  ) {}

  /**
   * 获取应用基础 URL（优先使用 APP_URL 环境变量，避免 Host Header 注入）
   */
  private get appUrl(): string {
    return this.configService.get<string>('APP_URL') || 'http://localhost:3000';
  }

  @Post('upload')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: multerFileSize } }))
  async uploadMultiple(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    // 大文件上传：禁用请求和响应超时
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
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: multerFileSize } }))
  async uploadAsync(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body('tagIds') tagIdsRaw?: any,
  ) {
    req.setTimeout(0);
    res.setTimeout(0);
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }
    const tagIds = parseTagIdsBody(tagIdsRaw);
    if (tagIds?.length) await this.tagService.assertOwner(user.id, tagIds);
    return this.fileService.uploadAsync(file, user, tagIds, req);
  }

  /**
   * 异步批量上传
   */
  @Post('upload-multiple-async')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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
      return this.fileService.findAll(Number(page), Number(limit), user.id, keyword, shouldIncludeDeleted, sortBy, sortOrder, cursor, tagIds);
    }
    // Admin: only show all files when userId filter is explicitly provided;
    // default to own files for the "我的文件" page
    return this.fileService.findAll(Number(page), Number(limit), userId || user.id, keyword, shouldIncludeDeleted, sortBy, sortOrder, cursor, tagIds);
  }

  /**
   * 获取缩略图加密公钥（每次服务重启自动生成新密钥对）
   */
  @Get('public-key')
  getPublicKey() {
    return { publicKey: this.cryptoService.getPublicKey() };
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
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

      if (Math.abs(Date.now() - timestamp) > 30_000) {
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
  @UseGuards(AuthGuard('jwt'))
  async download(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      // 下载限流：从安全配置动态读取阈值（热更新，无需重启）
      const clientIp = getClientIp(req);
      const downloadRateLimit = Number(await this.configCacheService.get('sec_download_rate_limit', '10')) || 10;
      const downloadRateWindow = Number(await this.configCacheService.get('sec_download_rate_window', '60')) || 60;
      const downloadRateBan = Number(await this.configCacheService.get('sec_download_rate_ban', '1')) || 1;
      const rateLimitResult = await this.rateLimitService.checkAndIncrement(
        `download:${clientIp}`,
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

      const result = await this.fileService.getFileContentStream(id, user, clientIp);

      res.set({
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
        'Content-Length': result.size.toString(),
        'Cache-Control': 'private, no-cache',
      });

      const pipe = promisify(pipeline);
      await pipe(result.stream, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败';
      const status = (error as { status?: number }).status || 500;
      if (!res.headersSent) {
        res.status(status).json({ code: 1, message });
      }
    }
  }

  @Put(':id/access-type')
  @UseGuards(AuthGuard('jwt'))
  async updateAccessType(
    @Param('id') id: string,
    @Body() data: UpdateAccessTypeDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateAccessType(id, data.accessType as FileAccessType, user);
    return { message: '访问权限已更新' };
  }

  @Put(':id/access-count')
  @UseGuards(AuthGuard('jwt'))
  async updateAccessCount(
    @Param('id') id: string,
    @Body() data: UpdateAccessCountDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateAccessCount(id, data.maxAccessCount, user);
    return { message: '访问次数限制已更新' };
  }

  @Put(':id/password')
  @UseGuards(AuthGuard('jwt'))
  async setPassword(
    @Param('id') id: string,
    @Body() data: SetPasswordDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.setPassword(id, data.password, user);
    return { message: '密码已设置' };
  }

  @Put(':id/expires')
  @UseGuards(AuthGuard('jwt'))
  async updateExpires(
    @Param('id') id: string,
    @Body() data: UpdateExpiresDto,
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateExpires(id, data.expiresIn, user);
    return { message: '有效期已更新' };
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  async delete(@Param('id') id: string, @CurrentUser() user: User) {
    const result = await this.fileService.delete(id, user);
    if (result.status === 'permanently_deleted') {
      return { message: '文件已永久删除', data: result };
    }
    if (result.status === 'already_deleted') {
      return { message: '文件已处于待删除状态', data: result };
    }
    return { message: '文件已标记为待删除，7 天后永久删除', data: result };
  }

  @Post(':id/restore')
  @UseGuards(AuthGuard('jwt'))
  async restoreDelete(@Param('id') id: string, @CurrentUser() user: User) {
    await this.fileService.restoreDelete(id, user);
    return { message: '文件已恢复' };
  }

  /** 文件主强制永久删除自己的文件（跳过 7 天等待期） */
  @Post(':id/force-delete')
  @UseGuards(AuthGuard('jwt'))
  async forceDelete(@Param('id') id: string, @CurrentUser() user: User) {
    await this.fileService.forceDelete(id, user);
    return { message: '文件已永久删除' };
  }

  @Post('batch-markdown')
  @UseGuards(AuthGuard('jwt'))
  async batchToMarkdown(
    @Body() data: BatchMarkdownDto,
    @CurrentUser() user: User,
  ) {
    const markdown = await this.fileService.batchToMarkdown(data.ids, user);
    return { markdown };
  }

  /** 设置文件标签（全量替换） */
  @Put(':id/tags')
  @UseGuards(AuthGuard('jwt'))
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
  @UseGuards(AuthGuard('jwt'))
  async removeFileTag(
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @CurrentUser() user: User,
  ) {
    await this.fileService.removeFileTag(id, user, tagId);
    return { message: '标签已移除' };
  }

  // Public file access — 三种模式：
  // 1. ?access= → 短效访问链接直接返回内容
  // 2. 无参数 → 无约束公开直返 / 有密码显示密码页 / 受限直接跳转短效访问链接
  // 3. ?ps=   → 密码验证后同上
  @Get('public/:id')
  async getPublicFile(
    @Param('id') id: string,
    @Query('access') access: string,
    @Query('ps') ps: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ip = getClientIp(req);

    try {
      // 模式 1：短效访问链接（30 秒有效，防重放）
      if (access) {
        await this.fileService.consumeAccessToken(access, id);
        const result = await this.fileService.getPublicFileContentStreamWithAccess(id, ip);
        res.set({
          'Content-Type': result.contentType,
          'Content-Disposition': result.isInline
            ? `inline; filename="${encodeURIComponent(result.filename)}"`
            : `attachment; filename="${encodeURIComponent(result.filename)}"`,
          'Content-Length': result.size.toString(),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        const pipe = promisify(pipeline);
        await pipe(result.stream, res);
        return;
      }

      // IP 封禁检查
      if (ip) {
        const ipCheck = await this.fileService.isIPBanned(ip);
        if (ipCheck.banned) {
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.type('html').send(getBannedPageHTML(ipCheck.message || 'IP已被封禁'));
          return;
        }
      }

      // 私有文件不允许公开访问
      const isPrivate = await this.fileService.isPrivateFile(id);
      if (isPrivate) {
        throw new BadRequestException('此文件为私有文件，不提供公开访问');
      }

      const hasPwd = await this.fileService.hasPassword(id);

      // 需要密码但未提供 → 显示密码页面
      if (hasPwd && !ps) {
        const currentUrl = `${this.appUrl}/files/public/${id}`;
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.type('html').send(getPasswordPageHTML(currentUrl, id));
        return;
      }

      // 提供了密码 → 验证
      if (hasPwd && ps) {
        const isPasswordValid = await this.fileService.verifyPassword(id, ps);
        if (!isPasswordValid) {
          // 记录失败尝试并检查封禁
          if (ip) {
            await this.fileService.recordFailedPasswordAttempt(ip);
            const ipCheck = await this.fileService.isIPBanned(ip);
            if (ipCheck.banned) {
              res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
              res.type('html').send(getBannedPageHTML(ipCheck.message || 'IP已被封禁'));
              return;
            }
          }
          const currentUrl = `${this.appUrl}/files/public/${id}`;
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.type('html').send(getPasswordPageHTML(currentUrl, id, '密码错误，请重试'));
          return;
        }
      }

      // 检查文件是否为无约束公开文件
      const unrestricted = await this.fileService.isUnrestrictedPublic(id);

      if (unrestricted) {
        // 无约束公开文件 → 流式返回
        const result = await this.fileService.getPublicFileContentStream(id, ip);
        res.set({
          'Content-Type': result.contentType,
          'Content-Disposition': result.isInline
            ? `inline; filename="${encodeURIComponent(result.filename)}"`
            : `attachment; filename="${encodeURIComponent(result.filename)}"`,
          'Content-Length': result.size.toString(),
          'Cache-Control': 'public, no-cache, must-revalidate, max-age=0',
        });
        const pipe = promisify(pipeline);
        await pipe(result.stream, res);
        return;
      }

      // 受限文件（时间/次数限制）→ 跳转一次性链接
      if (!hasPwd || (hasPwd && ps)) {
        const constrained = await this.fileService.checkAndIncrementAccess(id);
        if (!constrained.allowed) {
          throw new BadRequestException(constrained.reason || '文件访问受限');
        }
        const accessToken = this.fileService.generateAccessToken(id);
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.redirect(302, `${this.appUrl}/api/files/public/${id}?access=${accessToken}`);
        return;
      }

      // 不应到达此处
      throw new BadRequestException('无法访问此文件');
    } catch (error) {
      const message = error instanceof Error ? error.message : '请求失败';
      const status = (error as { status?: number }).status || 500;
      res.status(status).json({ code: 1, message });
    }
  }

  // Generate share link
  @Get(':id/share')
  @UseGuards(AuthGuard('jwt'))
  async generateShareLink(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    const link = await this.fileService.generateShareLink(id, user);
    return { link };
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** 解析请求体中的 tagIds 字段，支持字符串和数组格式 */
function parseTagIdsBody(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').filter(Boolean);
  return undefined;
}

function getPasswordPageHTML(actionUrl: string, _fileId: string, errorMsg?: string): string {
  const escapedError = errorMsg ? `<div style="background:#F8514922;color:#F85149;padding:12px 16px;border-radius:8px;margin-bottom:20px;font-size:14px;border:1px solid rgba(248,81,73,0.3);">${escapeHtml(errorMsg)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>文件密码验证</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0D1117;font-family:'PingFang SC','Microsoft YaHei',sans-serif;">
<div style="background:#21262D;padding:40px;border-radius:16px;width:100%;max-width:380px;border:1px solid #30363D;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
<div style="text-align:center;margin-bottom:24px;">
<div style="font-size:48px;margin-bottom:8px;">🔒</div>
<h1 style="font-size:20px;color:#E6EDF3;margin:0;">加密文件</h1>
<p style="color:#8B949E;font-size:14px;margin-top:8px;">此文件需要密码才能访问</p>
</div>
${escapedError}
<form method="GET" action="${escapeHtml(actionUrl)}">
<div style="margin-bottom:16px;">
<input type="password" name="ps" placeholder="请输入访问密码" autofocus required style="width:100%;padding:12px;background:#0D1117;border:1px solid #30363D;border-radius:8px;color:#E6EDF3;font-size:16px;outline:none;box-sizing:border-box;" />
</div>
<button type="submit" style="width:100%;padding:12px;background:#0052D9;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:500;">验证</button>
</form>
</div>
</body>
</html>`;
}

function getBannedPageHTML(message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>访问受限</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0D1117;font-family:'PingFang SC','Microsoft YaHei',sans-serif;">
<div style="background:#21262D;padding:40px;border-radius:16px;width:100%;max-width:380px;border:1px solid #30363D;box-shadow:0 8px 32px rgba(0,0,0,0.4);text-align:center;">
<div style="font-size:64px;margin-bottom:16px;">🚫</div>
<h1 style="font-size:20px;color:#E6EDF3;margin:0;">访问受限</h1>
<p style="color:#8B949E;font-size:14px;margin-top:16px;line-height:1.6;">${escapeHtml(message)}</p>
<div style="margin-top:24px;padding:12px 16px;background:#F8514922;border-radius:8px;border:1px solid rgba(248,81,73,0.3);">
<p style="color:#F85149;font-size:13px;margin:0;">密码错误次数过多，请稍后再试</p>
</div>
</div>
</body>
</html>`;
}


import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { getClientIp } from '../common/utils/client-ip';
import { sanitizePreviewContentType } from '../common/utils/preview-content-type';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { ShareService } from './share.service';
import { FileService, RangeNotSatisfiableException } from '../file/file.service';
import { CreateShareDto, UpdateShareDto, VerifyPasswordDto } from './share.dto';
import { ShareTargetType } from '../common/entities/share-link.entity';

/**
 * 记录 pipeline 前的已发送字节数，返回一个用于 pipeline 完成后更新日志的闭包。
 * 与 file.controller.ts 的 trackBytesSent 同原理（socket.bytesWritten 差值）。
 */
function trackBytesSent(res: Response): () => number {
  const startBytes = res.socket?.bytesWritten ?? 0;
  return () => (res.socket?.bytesWritten ?? 0) - startBytes;
}

/**
 * 分享链接控制器。
 *
 * 路由设计：
 * - POST   /api/shares            创建分享（需登录）
 * - GET    /api/shares            列出我的分享（需登录）
 * - GET    /api/shares/:id        查看分享详情（需登录）
 * - PATCH  /api/shares/:id        更新分享设置（需登录）
 * - DELETE /api/shares/:id        取消分享（需登录）
 * - GET    /api/s/:token          公开入口，返回元数据（**不返回字节**）
 * - POST   /api/s/:token/verify   提交密码验证
 * - GET    /api/s/:token/download/:fileId   公开下载入口
 *
 * 注意：/api/s/:token 系列路由**不带** JwtAuthGuard，但 ShareService 内部
 * 严格校验 token + access JWT（若需密码）。
 *
 * 路由冲突注意：/s/:token 与 /s/:token/verify、/s/:token/download/:fileId
 * 不会冲突，因为静态段 /verify 和 /download/:fileId 优先于 :token 占位。
 */
@Controller()
export class ShareController {
  constructor(
    private readonly shareService: ShareService,
    private readonly fileService: FileService,
    private readonly rateLimitService: RateLimitService,
    private readonly configCacheService: ConfigCacheService,
  ) {}

  /**
   * 公开分享端点的 IP+token 维度限流。
   * 防止攻击者高频访问 /s/:token 系列接口，快速耗尽 maxAccessCount（DoS）。
   * 阈值从安全配置动态读取（热更新），默认 60 次/分钟。
   */
  private async assertShareRateLimit(token: string, req: Request): Promise<void> {
    const ip = getClientIp(req);
    const limit = Number(await this.configCacheService.get('sec_share_rate_limit', '60')) || 60;
    const windowMs = (Number(await this.configCacheService.get('sec_share_rate_window', '60')) || 60) * 1000;
    const lockMs = (Number(await this.configCacheService.get('sec_share_rate_ban', '60')) || 60) * 1000;
    const result = await this.rateLimitService.checkAndIncrement(
      `share:${ip}:${token}`,
      'share_access',
      limit,
      lockMs,
      windowMs,
    );
    if (!result.allowed) {
      throw new HttpException('访问过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * 分享预览端点的独立限流（与下载限流分离）。
   * 视频 seek 会产生大量 Range 请求，阈值放宽为 sec_share_rate_limit 的 3 倍
   * （默认 60×3=180 次），窗口与锁定时长沿用同一配置。
   */
  private async assertSharePreviewRateLimit(token: string, req: Request): Promise<void> {
    const ip = getClientIp(req);
    const baseLimit = Number(await this.configCacheService.get('sec_share_rate_limit', '60')) || 60;
    const windowMs = (Number(await this.configCacheService.get('sec_share_rate_window', '60')) || 60) * 1000;
    const lockMs = (Number(await this.configCacheService.get('sec_share_rate_ban', '60')) || 60) * 1000;
    const result = await this.rateLimitService.checkAndIncrement(
      `share_preview:${ip}:${token}`,
      'share_access',
      baseLimit * 3,
      lockMs,
      windowMs,
    );
    if (!result.allowed) {
      throw new HttpException('访问过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  // ==================== 需登录的接口 ====================

  @Post('shares')
  @UseGuards(JwtAuthGuard)
  async createShare(@CurrentUser() user: User, @Body() dto: CreateShareDto) {
    return this.shareService.createShare(user.id, dto);
  }

  @Get('shares')
  @UseGuards(JwtAuthGuard)
  async listMyShares(
    @CurrentUser() user: User,
    @Query('targetType') targetType?: ShareTargetType,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.shareService.listMyShares(user.id, {
      targetType: targetType as ShareTargetType | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('shares/:id')
  @UseGuards(JwtAuthGuard)
  async getShare(@Param('id') id: string, @CurrentUser() user: User) {
    return this.shareService.getShareById(id, user.id);
  }

  @Patch('shares/:id')
  @UseGuards(JwtAuthGuard)
  async updateShare(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateShareDto,
  ) {
    return this.shareService.updateShare(id, user.id, dto);
  }

  @Delete('shares/:id')
  @UseGuards(JwtAuthGuard)
  async cancelShare(@Param('id') id: string, @CurrentUser() user: User) {
    await this.shareService.cancelShare(id, user.id);
    return { status: 'cancelled' };
  }

  // ==================== 公开接口（/s/:token） ====================

  /**
   * 公开访问入口：返回分享元数据，**不返回文件字节**。
   * 严格模式：需密码且未通过 access JWT → 只返回 { requiresPassword: true }，
   * 不查询 target 表。
   */
  @Get('s/:token')
  async getSharePublicInfo(
    @Param('token') token: string,
    @Query('access') accessJwt: string,
    @Req() req: Request,
  ) {
    await this.assertShareRateLimit(token, req);
    return this.shareService.getSharePublicInfo(token, accessJwt || undefined);
  }

  /**
   * 密码验证入口：提交明文密码，验证通过后返回 5 分钟 access JWT。
   * access JWT 由前端保存到内存（不入 localStorage），后续下载时附带。
   */
  @Post('s/:token/verify')
  async verifyPassword(
    @Param('token') token: string,
    @Body() dto: VerifyPasswordDto,
    @Req() req: Request,
  ) {
    const ip = getClientIp(req);
    return this.shareService.verifyPassword(token, dto.password, ip);
  }

  /**
   * 公开下载入口：流式返回文件内容。
   * 需要校验：
   * - 分享链接存在且可用
   * - 若分享有密码，必须带有效的 access JWT（query 参数 ?access=）
   * - fileId 必须属于此分享的 target
   */
  @Get('s/:token/download/:fileId')
  async downloadFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Query('access') accessJwt: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.assertShareRateLimit(token, req);
    const ip = getClientIp(req);
    const result = await this.shareService.getShareDownloadStream(
      token,
      fileId,
      accessJwt || undefined,
      ip,
    );

    res.set({
      'Content-Type': result.contentType,
      // 分享下载始终用 attachment 触发浏览器原生下载 UI，不内联预览
      'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
      'Content-Length': result.size.toString(),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });

    const pipe = promisify(pipeline);
    try {
      await pipe(result.stream, res);
    } catch (err) {
      // 头部未发送：还能返回标准错误响应
      if (!res.headersSent) {
        throw new BadRequestException('下载失败：' + (err as Error).message);
      }
      // 头部已发送：无法再改状态码，记录日志并中断响应，
      // 让客户端感知到截断（Content-Length 与实际字节不符），而非静默吞错。
      res.destroy(err as Error);
    }
  }

  /**
   * 公开预览端点：inline 返回文件内容供分享页内预览。
   * 校验链与下载一致（Service 内部校验 token/密码/fileId 归属），差异：
   * - Content-Disposition 为 inline，支持 Range（Range 不消费访问额度）
   * - 独立限流（阈值为下载端点的 3 倍）
   * - 防 XSS：html/svg+xml/xml 类型强制降级为 text/plain（配合 nosniff）
   */
  @Get('s/:token/preview/:fileId')
  async previewFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Query('access') accessJwt: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      await this.assertSharePreviewRateLimit(token, req);
      const ip = getClientIp(req);
      const rangeHeader = req.headers.range;
      const result = await this.shareService.getSharePreviewStream(
        token,
        fileId,
        accessJwt || undefined,
        ip,
        rangeHeader || undefined,
      );

      // 命中 Range → 206 + Content-Range；否则 200 全量
      const isRange = result.start !== undefined && result.end !== undefined && result.total !== undefined;
      if (isRange) {
        res.status(206);
      }
      res.set({
        'Content-Type': sanitizePreviewContentType(result.contentType),
        'Content-Disposition': `inline; filename="${encodeURIComponent(result.filename)}"`,
        'Content-Length': result.size.toString(),
        ...(isRange ? { 'Content-Range': `bytes ${result.start}-${result.end}/${result.total}` } : {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      });

      const getBytesSent = trackBytesSent(res);
      const pipe = promisify(pipeline);
      try {
        await pipe(result.stream, res);
      } finally {
        // 回填实际传输字节数到访问日志（responseSize 先占位为 0）
        if (result.accessLogId) {
          await this.fileService.updateAccessLogResponseSize(result.accessLogId, getBytesSent());
        }
      }
    } catch (error) {
      // 头部未发送：返回标准 JSON 错误；头部已发送：中断响应让客户端感知截断
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

  /**
   * 浏览文件夹分享中的子文件夹内容（公开接口）。
   * 若分享有密码，必须带有效的 access JWT（query 参数 ?access=）。
   * 后端校验 folderId 在分享 target 子树内后返回 subfolders + files。
   */
  @Get('s/:token/folder/:folderId/contents')
  async listFolderContents(
    @Param('token') token: string,
    @Param('folderId') folderId: string,
    @Query('access') accessJwt: string,
    @Req() req: Request,
  ) {
    await this.assertShareRateLimit(token, req);
    const link = await this.shareService.getShareLinkByToken(token);
    await this.shareService.assertShareUsablePublic(link);
    // 严格模式：密码校验
    if (link.password) {
      if (!accessJwt) {
        return { requiresPassword: true };
      }
      const ok = await this.shareService.verifyAccessJwtForLink(link, accessJwt);
      if (!ok) return { requiresPassword: true };
    }
    await this.shareService.consumeShareAccess(link);
    return this.shareService.listFolderContentsForShare(link, folderId);
  }

  /**
   * 返回从分享根文件夹到当前 folderId 的路径（面包屑）。
   * 同样支持严格模式密码校验。
   */
  @Get('s/:token/folder/:folderId/breadcrumb')
  async getFolderBreadcrumb(
    @Param('token') token: string,
    @Param('folderId') folderId: string,
    @Query('access') accessJwt: string,
    @Req() req: Request,
  ) {
    await this.assertShareRateLimit(token, req);
    const link = await this.shareService.getShareLinkByToken(token);
    await this.shareService.assertShareUsablePublic(link);
    if (link.password) {
      if (!accessJwt) {
        return { requiresPassword: true };
      }
      const ok = await this.shareService.verifyAccessJwtForLink(link, accessJwt);
      if (!ok) return { requiresPassword: true };
    }
    return { breadcrumb: await this.shareService.getFolderBreadcrumbForShare(link, folderId) };
  }
}

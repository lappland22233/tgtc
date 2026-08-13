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
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response, CookieOptions } from 'express';
import { createHash, randomBytes } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { getClientIp } from '../common/utils/client-ip';
import { sanitizePreviewContentType } from '../common/utils/preview-content-type';
import { buildContentDisposition } from '../common/utils/content-disposition';
import { RateLimitService } from '../common/services/rate-limit.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { StreamResponderService } from '../common/services/stream-responder.service';
import { ShareService } from './share.service';
import { FileService } from '../file/file.service';
import { CreateShareDto, UpdateShareDto, VerifyPasswordDto } from './share.dto';
import { ShareTargetType } from '../common/entities/share-link.entity';

/**
 * 分享访问凭据 HttpOnly Cookie 名。
 * 密码验证成功后由服务端下发短期、不透明、不可读的 Cookie，
 * 适配原生 img/audio/video/iframe 无法可靠设置 Authorization Header 的限制（C-02 修复）。
 */
const SHARE_ACCESS_COOKIE = 'share_access';
/** 分享访问凭据有效期（与 access JWT 5 分钟对齐） */
const SHARE_ACCESS_TTL_MS = 5 * 60 * 1000;
/** 分享访客会话 Cookie：用于派生预览会话的不可逆访客标识（C-03 修复） */
const SHARE_VISITOR_COOKIE = 'share_visitor';
/** 访客 Cookie 有效期（与 access JWT 对齐，避免长期留存） */
const SHARE_VISITOR_TTL_MS = 5 * 60 * 1000;

/** 分享访问 Cookie 选项：HttpOnly、受限 Path、短 TTL、SameSite=Lax（与认证 Cookie 一致）。 */
function shareAccessCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.SECURE_COOKIE === 'true' || req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    path: '/api/s/',
    maxAge: SHARE_ACCESS_TTL_MS,
  };
}

/** 分享访客 Cookie 选项：HttpOnly、不可读、短 TTL、受限 Path。 */
function shareVisitorCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.SECURE_COOKIE === 'true' || req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    path: '/api/s/',
    maxAge: SHARE_VISITOR_TTL_MS,
  };
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
    private readonly streamResponder: StreamResponderService,
  ) {}

  /**
   * 读取分享访问凭据：优先从 HttpOnly Cookie（C-02 新流程）读取，
   * 兼容期回退到旧 query 参数 ?access=（迁移完成前保持双读）。
   * 返回 undefined 表示未携带凭据。
   */
  private getAccessJwt(req: Request): string | undefined {
    const fromCookie = typeof req.cookies?.[SHARE_ACCESS_COOKIE] === 'string'
      ? (req.cookies[SHARE_ACCESS_COOKIE] as string)
      : undefined;
    if (fromCookie) return fromCookie;
    const fromQuery = typeof req.query.access === 'string' ? req.query.access : undefined;
    return fromQuery;
  }

  /**
   * 获取（必要时签发）分享访客会话标识的 sha256 摘要（C-03 修复）。
   *
   * - 首次预览请求时下发短期 HttpOnly `share_visitor` Cookie（高熵随机值），
   *   浏览器原生 img/audio/video 子请求自动携带；
   * - visitorHash = sha256(Cookie 值)，仅存不可逆摘要到分享预览会话表，
   *   原始 Cookie 值不落库、不进日志；
   * - 同 Cookie（同访客 + 同分享路径）派生同一 hash → 同会话幂等免扣；
   *   换浏览器/清 Cookie → 新 hash → 新会话重新计数。
   */
  private getOrCreateVisitorHash(req: Request, res: Response): string {
    let visitor = typeof req.cookies?.[SHARE_VISITOR_COOKIE] === 'string'
      ? (req.cookies[SHARE_VISITOR_COOKIE] as string)
      : '';
    if (!visitor || visitor.length < 32) {
      visitor = randomBytes(32).toString('base64url');
      res.cookie(SHARE_VISITOR_COOKIE, visitor, shareVisitorCookieOptions(req));
    }
    return createHash('sha256').update(`share-visitor:${visitor}`).digest('hex');
  }

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
    @Req() req: Request,
  ) {
    await this.assertShareRateLimit(token, req);
    return this.shareService.getSharePublicInfo(token, this.getAccessJwt(req));
  }

  /**
   * 密码验证入口：提交明文密码，验证通过后由服务端下发短期 HttpOnly Cookie。
   * 前端不再持有或拼接 access JWT（C-02 修复）；兼容期内响应体仍带 accessJwt，
   * 供旧前端/紧急回滚使用，新流程只依赖 Cookie。
   */
  @Post('s/:token/verify')
  async verifyPassword(
    @Param('token') token: string,
    @Body() dto: VerifyPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = getClientIp(req);
    const { accessJwt } = await this.shareService.verifyPassword(token, dto.password, ip);
    res.cookie(SHARE_ACCESS_COOKIE, accessJwt, shareAccessCookieOptions(req));
    return { accessJwt };
  }

  /** 公开媒体缩略图：鉴权但不计入分享访问/下载次数。 */
  @Get('s/:token/thumbnail/:fileId')
  async getThumbnail(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.assertShareRateLimit(token, req);
    const accessJwt = this.getAccessJwt(req);
    const result = await this.shareService.getShareThumbnailStream(token, fileId, accessJwt);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', accessJwt ? 'private, max-age=300' : 'public, max-age=300');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    result.stream.pipe(res);
  }

  /** 公开高清封面：鉴权但不计入分享访问/下载次数。 */
  @Get('s/:token/thumbnail-hd/:fileId')
  async getHdThumbnail(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.assertShareRateLimit(token, req);
    const accessJwt = this.getAccessJwt(req);
    const result = await this.shareService.getShareHdThumbnailStream(token, fileId, accessJwt);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', accessJwt ? 'private, max-age=300' : 'public, max-age=300');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    result.stream.pipe(res);
  }

  /** 分享文件缓存状态：供前端判断冷资源单连接策略，不消费访问次数。 */
  @Get('s/:token/cache-status/:fileId')
  async getCacheStatus(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
  ) {
    await this.assertShareRateLimit(token, req);
    return this.shareService.getShareCacheStatus(token, fileId, this.getAccessJwt(req));
  }

  /**
   * 公开下载入口：流式返回文件内容。
   * 需要校验：
   * - 分享链接存在且可用
   * - 若分享有密码，必须携带有效的访问凭据（HttpOnly Cookie `share_access` 优先，兼容期接受 query ?access=）
   * - fileId 必须属于此分享的 target
   */
  @Get('s/:token/download/:fileId')
  async downloadFile(
    @Param('token') token: string,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.assertShareRateLimit(token, req);
    const ip = getClientIp(req);
    const result = await this.shareService.getShareDownloadStream(
      token,
      fileId,
      this.getAccessJwt(req),
      ip,
    );

    await this.streamResponder.send({
      res,
      headers: {
        'Content-Type': result.contentType,
        // 分享下载始终用 attachment 触发浏览器原生下载 UI，不内联预览
        'Content-Disposition': buildContentDisposition('attachment', result.filename),
        'Content-Length': result.size.toString(),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
      stream: result.stream,
      accessLogId: result.accessLogId,
      updateAccessLog: (id, bytes) => this.fileService.updateAccessLogResponseSize(id, bytes),
    });
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
        this.getAccessJwt(req),
        ip,
        rangeHeader || undefined,
        this.getOrCreateVisitorHash(req, res),
      );

      // 命中 Range → 206 + Content-Range；否则 200 全量
      const isRange = result.start !== undefined && result.end !== undefined && result.total !== undefined;
      await this.streamResponder.send({
        res,
        status: isRange ? 206 : undefined,
        range: isRange
          ? { start: result.start!, end: result.end!, total: result.total! }
          : undefined,
        headers: {
          'Content-Type': sanitizePreviewContentType(result.contentType),
          'Content-Disposition': buildContentDisposition('inline', result.filename),
          'Content-Length': result.size.toString(),
          'Accept-Ranges': rangeHeader && !isRange ? 'none' : 'bytes',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
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

  /**
   * 浏览文件夹分享中的子文件夹内容（公开接口）。
   * 若分享有密码，必须携带有效的访问凭据（HttpOnly Cookie `share_access` 优先，兼容期接受 query ?access=）。
   * 后端校验 folderId 在分享 target 子树内后返回 subfolders + files。
   */
  @Get('s/:token/folder/:folderId/contents')
  async listFolderContents(
    @Param('token') token: string,
    @Param('folderId') folderId: string,
    @Req() req: Request,
  ) {
    await this.assertShareRateLimit(token, req);
    const link = await this.shareService.getShareLinkByToken(token);
    await this.shareService.assertShareUsablePublic(link);
    // 严格模式：密码校验
    const accessJwt = this.getAccessJwt(req);
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
    @Req() req: Request,
  ) {
    await this.assertShareRateLimit(token, req);
    const link = await this.shareService.getShareLinkByToken(token);
    await this.shareService.assertShareUsablePublic(link);
    const accessJwt = this.getAccessJwt(req);
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

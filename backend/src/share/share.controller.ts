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
} from '@nestjs/common';
import { Request, Response } from 'express';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { getClientIp } from '../common/utils/client-ip';
import { ShareService } from './share.service';
import { CreateShareDto, UpdateShareDto, VerifyPasswordDto } from './share.dto';
import { ShareTargetType } from '../common/entities/share-link.entity';

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
  constructor(private readonly shareService: ShareService) {}

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
  ) {
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
      'Accept-Ranges': 'bytes',
    });

    const pipe = promisify(pipeline);
    try {
      await pipe(result.stream, res);
    } catch (err) {
      // 客户端断开连接等错误，记录但不影响响应（响应已开始）
      if (!res.headersSent) {
        throw new BadRequestException('下载失败：' + (err as Error).message);
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
  ) {
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
  ) {
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

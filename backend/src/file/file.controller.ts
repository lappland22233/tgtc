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
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { FileService } from './file.service';
import { GenerateShareLinkDto, BatchMarkdownDto } from './file.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { FileAccessType } from '../common/entities/file.entity';

@Controller('files')
export class FileController {
  constructor(private fileService: FileService, private configService: ConfigService) {}

  @Post('upload')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
  ) {
    return this.fileService.upload(file, user);
  }

  @Post('upload-multiple')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FilesInterceptor('files', 10))
  async uploadMultiple(
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: User,
  ) {
    return this.fileService.uploadMultiple(files, user);
  }

  @Get('upload-config')
  async getUploadConfig() {
    const maxFileSize = await this.fileService.getMaxFileSize();
    const allowedTypes = await this.fileService.getAllowedTypes();
    return { maxFileSize, allowedTypes };
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @CurrentUser() user: User,
    @Query('userId') userId?: string,
    @Query('keyword') keyword?: string,
  ) {
    // Non-admin users can only see their own files
    if (user.role === UserRole.USER) {
      return this.fileService.findAll(Number(page), Number(limit), user.id, keyword);
    }
    return this.fileService.findAll(Number(page), Number(limit), userId, keyword);
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  async findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.fileService.findOne(id, user);
  }

  @Get(':id/download')
  @UseGuards(AuthGuard('jwt'))
  async download(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Res() res: Response,
  ) {
    try {
      const result = await this.fileService.getFileContent(id, user);

      res.set({
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
        'Content-Length': result.size.toString(),
        'Cache-Control': 'private, no-cache',
      });

      res.send(result.content);
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败';
      const status = (error as { status?: number }).status || 500;
      res.status(status).json({ code: 1, message });
    }
  }

  @Put(':id/access-type')
  @UseGuards(AuthGuard('jwt'))
  async updateAccessType(
    @Param('id') id: string,
    @Body() data: { accessType: FileAccessType },
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateAccessType(id, data.accessType, user);
    return { message: '访问权限已更新' };
  }

  @Put(':id/access-count')
  @UseGuards(AuthGuard('jwt'))
  async updateAccessCount(
    @Param('id') id: string,
    @Body() data: { maxAccessCount: number },
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateAccessCount(id, data.maxAccessCount, user);
    return { message: '访问次数限制已更新' };
  }

  @Put(':id/password')
  @UseGuards(AuthGuard('jwt'))
  async setPassword(
    @Param('id') id: string,
    @Body() data: { password: string },
    @CurrentUser() user: User,
  ) {
    await this.fileService.setPassword(id, data.password, user);
    return { message: '密码已设置' };
  }

  @Put(':id/expires')
  @UseGuards(AuthGuard('jwt'))
  async updateExpires(
    @Param('id') id: string,
    @Body() data: { expiresIn: number | null },
    @CurrentUser() user: User,
  ) {
    await this.fileService.updateExpires(id, data.expiresIn, user);
    return { message: '有效期已更新' };
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'))
  async delete(@Param('id') id: string, @CurrentUser() user: User) {
    await this.fileService.delete(id, user);
    return { message: '文件已删除' };
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

  // Public file access — 简化后的三种模式：
  // 1. ?access= → 一次性访问链接直接返回内容
  // 2. 无参数 → 无约束公开直返 / 有密码显示密码页 / 受限直接跳转一次性链接
  // 3. ?ps=   → 密码验证后同上
  @Get('public/:id')
  async getPublicFile(
    @Param('id') id: string,
    @Query('access') access: string,
    @Query('ps') ps: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;

    try {
      // 模式 1：一次性访问链接
      if (access) {
        this.fileService.validateAccessToken(access, id);
        const result = await this.fileService.getPublicFileContentDirect(id);
        res.set({
          'Content-Type': result.contentType,
          'Content-Disposition': result.isInline
            ? `inline; filename="${encodeURIComponent(result.filename)}"`
            : `attachment; filename="${encodeURIComponent(result.filename)}"`,
          'Content-Length': result.size.toString(),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.send(result.content);
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

      const hasPwd = await this.fileService.hasPassword(id);

      // 需要密码但未提供 → 显示密码页面
      if (hasPwd && !ps) {
        const proto = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        const currentUrl = `${proto}://${host}/files/public/${id}`;
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
          const proto = req.protocol || 'http';
          const host = req.get('host') || 'localhost:3000';
          const currentUrl = `${proto}://${host}/files/public/${id}`;
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.type('html').send(getPasswordPageHTML(currentUrl, id, '密码错误，请重试'));
          return;
        }
      }

      // 检查文件是否为无约束公开文件
      const unrestricted = await this.fileService.isUnrestrictedPublic(id);

      if (unrestricted) {
        // 无约束公开文件 → 直接返回
        const result = await this.fileService.getPublicFileContentDirect(id);
        res.set({
          'Content-Type': result.contentType,
          'Content-Disposition': result.isInline
            ? `inline; filename="${encodeURIComponent(result.filename)}"`
            : `attachment; filename="${encodeURIComponent(result.filename)}"`,
          'Content-Length': result.size.toString(),
          'Cache-Control': 'public, max-age=3600',
        });
        res.send(result.content);
        return;
      }

      // 受限文件（时间/次数限制）→ 跳转一次性链接
      if (!hasPwd || (hasPwd && ps)) {
        const constrained = await this.fileService.checkAndIncrementAccess(id, ip);
        if (!constrained.allowed) {
          throw new BadRequestException(constrained.reason || '文件访问受限');
        }
        const accessToken = this.fileService.generateAccessToken(id);
        const proto = req.protocol || 'http';
        const host = req.get('host') || 'localhost:3000';
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.redirect(302, `${proto}://${host}/api/files/public/${id}?access=${accessToken}`);
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

  // Revoke all share links for a file
  @Post(':id/share/revoke')
  @UseGuards(AuthGuard('jwt'))
  async revokeShareLink(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    await this.fileService.revokeShareLink(id, user);
    return { message: '分享链接已全部撤销' };
  }
}

function getPasswordPageHTML(actionUrl: string, fileId: string, errorMsg?: string): string {
  const error = errorMsg
    ? `<div style="background:#F8514922;color:#F85149;padding:12px 16px;border-radius:8px;margin-bottom:20px;font-size:14px;border:1px solid rgba(248,81,73,0.3);">❌ ${errorMsg}</div>`
    : '';
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
${error}
<form method="GET" action="${actionUrl}">
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
<p style="color:#8B949E;font-size:14px;margin-top:16px;line-height:1.6;">${message}</p>
<div style="margin-top:24px;padding:12px 16px;background:#F8514922;border-radius:8px;border:1px solid rgba(248,81,73,0.3);">
<p style="color:#F85149;font-size:13px;margin:0;">密码错误次数过多，请稍后再试</p>
</div>
</div>
</body>
</html>`;
}


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

  // Public file access — 三种模式：
  // 1. 无参数 → 无约束公开文件直接访问（CDN 缓存友好）
  // 2. ?token= → 分享链接访问（受限文件 302 跳转一次性链接）
  // 3. ?access= → 一次性链接直接返回内容（no-cache）
  @Get('public/:id')
  async getPublicFile(
    @Param('id') id: string,
    @Query('token') token: string,
    @Query('access') access: string,
    @Query('password') password: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;

    try {
      // 模式 3：一次性访问链接（重定向目标）
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

      // 模式 2：分享链接（带 token）
      if (token) {
        const { file, isConstrained } = await this.fileService.validateShareToken(id, token, ip, password);

        if (isConstrained) {
          // 受限文件 → 302 重定向到一次性链接，防止 CDN 缓存
          const accessToken = this.fileService.generateAccessToken(id);
          const proto = req.protocol || 'http';
          const host = req.get('host') || 'localhost:3000';
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.redirect(302, `${proto}://${host}/api/files/public/${id}?access=${accessToken}`);
          return;
        }

        // 无约束分享链接（单次使用但无访问限制）→ 直接返回
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

      // 模式 1：无任何参数 → 仅无约束公开文件可访问
      const unrestricted = await this.fileService.isUnrestrictedPublic(id);
      if (!unrestricted) {
        throw new BadRequestException('此文件需要有效分享链接才能访问');
      }

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
    @Query() query: GenerateShareLinkDto,
  ) {
    const link = await this.fileService.generateShareLink(id, user, query.expiresIn);
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

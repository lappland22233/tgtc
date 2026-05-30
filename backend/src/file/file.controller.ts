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
import { FileService } from './file.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { FileAccessType } from '../common/entities/file.entity';

@Controller('files')
export class FileController {
  constructor(private fileService: FileService) {}

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

  @Get()
  @UseGuards(AuthGuard('jwt'))
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @CurrentUser() user: User,
    @Query('userId') userId?: string,
  ) {
    // Non-admin users can only see their own files
    if (user.role === UserRole.USER) {
      return this.fileService.findAll(Number(page), Number(limit), user.id);
    }
    return this.fileService.findAll(Number(page), Number(limit), userId);
  }

  @Get(':id')
  @UseGuards(AuthGuard('jwt'))
  async findOne(@Param('id') id: string) {
    return this.fileService.findOne(id);
  }

  @Get(':id/download')
  @UseGuards(AuthGuard('jwt'))
  async download(
    @Param('id') id: string,
    @Query('password') password?: string,
  ) {
    return this.fileService.getFileContent(id, password);
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
  async batchToMarkdown(@Body() data: { ids: string[] }) {
    const markdown = await this.fileService.batchToMarkdown(data.ids);
    return { markdown };
  }

  // Public file access via share token (JWT signed) - 返回文件内容，图片视频直接预览，其他触发下载
  @Get('public/:id')
  async getPublicFile(
    @Param('id') id: string,
    @Query('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!token) {
      throw new BadRequestException('请提供有效的分享链接 token');
    }
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;

    try {
      const result = await this.fileService.getPublicFileContent(id, token, ip);

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
      // 用 JSON 格式返回错误
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
    @Query('expiresIn') expiresIn?: string, // hours
  ) {
    const link = await this.fileService.generateShareLink(id, user, expiresIn ? parseInt(expiresIn) : undefined);
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

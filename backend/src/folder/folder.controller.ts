import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { FolderService } from './folder.service';
import {
  CreateFolderDto,
  RenameFolderDto,
  MoveFolderDto,
  ListContentsQueryDto,
} from './folder.dto';

/**
 * 文件夹控制器：网盘层级管理 API。
 *
 * 所有接口需登录（@UseGuards(JwtAuthGuard)），并通过 @CurrentUser 获取用户身份。
 * 全局前缀 /api；本控制器路由前缀 /folders。
 *
 * 路由列表：
 * - GET    /folders/tree                    返回当前用户的完整文件夹树（左侧导航）
 * - GET    /folders/breadcrumb?parentId=    返回从根到指定 folder 的路径
 * - GET    /folders/contents?parentId=      列出子文件夹 + 文件（主区域视图）
 * - POST   /folders                         创建文件夹
 * - PATCH  /folders/:id                     重命名
 * - PATCH  /folders/:id/move                移动到新父级
 * - DELETE /folders/:id                     软删除（7 天延迟）
 * - POST   /folders/:id/restore             恢复软删
 */
@Controller('folders')
@UseGuards(JwtAuthGuard)
export class FolderController {
  constructor(private readonly folderService: FolderService) {}

  @Get('tree')
  async getTree(@CurrentUser() user: User) {
    return { tree: await this.folderService.getTree(user.id) };
  }

  @Get('breadcrumb')
  async getBreadcrumb(
    @CurrentUser() user: User,
    @Query('parentId') parentId?: string | null,
  ) {
    // parentId 缺省/空字符串/null 都视为根目录
    const folderId = parentId && parentId !== 'null' && parentId !== '' ? parentId : null;
    return { breadcrumb: await this.folderService.getBreadcrumb(user.id, folderId) };
  }

  @Get('contents')
  async listContents(
    @CurrentUser() user: User,
    @Query() query: ListContentsQueryDto,
  ) {
    const parentId = query.parentId && query.parentId !== 'null' ? query.parentId : null;
    const contents = await this.folderService.listContents(user.id, parentId, {
      includeDeleted: query.includeDeleted,
    });
    return contents;
  }

  @Post()
  async createFolder(@CurrentUser() user: User, @Body() dto: CreateFolderDto) {
    return { folder: await this.folderService.createFolder(user.id, dto) };
  }

  @Patch(':id')
  async renameFolder(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: RenameFolderDto,
  ) {
    return { folder: await this.folderService.renameFolder(user.id, id, dto) };
  }

  @Patch(':id/move')
  async moveFolder(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: MoveFolderDto,
  ) {
    return { folder: await this.folderService.moveFolder(user.id, id, dto) };
  }

  @Delete(':id')
  async softDeleteFolder(@Param('id') id: string, @CurrentUser() user: User) {
    await this.folderService.softDeleteFolder(user.id, id);
    return { status: 'pending' };
  }

  @Post(':id/restore')
  async restoreFolder(@Param('id') id: string, @CurrentUser() user: User) {
    await this.folderService.restoreFolder(user.id, id);
    return { status: 'restored' };
  }
}

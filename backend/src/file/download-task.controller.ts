import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtOrApiKeyAuthGuard } from '../api-key/jwt-or-api-key.guard';
import { User } from '../common/entities/user.entity';
import { DownloadTaskService, type DownloadTaskView } from './download-task.service';

/**
 * 下载任务查询与取消端点（登录态与 API Key 均可）。
 * 创建入口在 `POST /api/files/:id/download-tasks`（需先通过文件访问权限校验）。
 */
@Controller('download-tasks')
export class DownloadTaskController {
  constructor(private readonly downloadTasks: DownloadTaskService) {}

  /** 查询任务状态：排队原因、近似位置与建议重试间隔 */
  @Get(':taskId')
  @UseGuards(JwtOrApiKeyAuthGuard)
  async getTask(
    @Param('taskId') taskId: string,
    @CurrentUser() user: User,
  ): Promise<DownloadTaskView> {
    return this.downloadTasks.refresh(taskId, ownerKeyOf(user));
  }

  /** 取消排队中的任务（幂等） */
  @Delete(':taskId')
  @UseGuards(JwtOrApiKeyAuthGuard)
  async cancelTask(
    @Param('taskId') taskId: string,
    @CurrentUser() user: User,
  ): Promise<DownloadTaskView> {
    return this.downloadTasks.cancel(taskId, ownerKeyOf(user));
  }
}

/** 任务归属键：仅用登录身份，防止跨用户读取/取消他人任务 */
export function ownerKeyOf(user: User): string {
  return `user:${user.id}`;
}

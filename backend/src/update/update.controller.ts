import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { getClientIp } from '../common/utils/client-ip';
import { User, UserRole } from '../common/entities/user.entity';
import { InstallUpdateDto, UpdateTasksQueryDto } from './dto';
import { UpdateService, UpdateStatusResponse, UpdateTaskSummary } from './update.service';
import { UpdateCheckResult } from './update-check.service';

/**
 * 系统更新管理端点。全部仅允许 super_admin；
 * 类级 @Roles(SUPER_ADMIN) 保证新增端点默认继承最严权限。
 */
@Controller('admin/update')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class UpdateController {
  constructor(private readonly updateService: UpdateService) {}

  @Get('status')
  async getStatus(): Promise<UpdateStatusResponse> {
    return this.updateService.getStatus();
  }

  @Post('check')
  async check(@CurrentUser() user: User, @Req() req: Request): Promise<UpdateCheckResult> {
    return this.updateService.check(user.id, getClientIp(req));
  }

  @Post('install')
  async install(
    @CurrentUser() user: User,
    @Req() req: Request,
    @Body() dto: InstallUpdateDto,
  ): Promise<UpdateTaskSummary> {
    return this.updateService.install(user.id, getClientIp(req), dto.releaseId);
  }

  @Get('tasks')
  async listTasks(@Query() query: UpdateTasksQueryDto): Promise<{ tasks: UpdateTaskSummary[] }> {
    return { tasks: await this.updateService.listTasks(query.limit) };
  }

  @Get('tasks/:taskId')
  async getTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<UpdateTaskSummary> {
    return this.updateService.getTask(taskId);
  }

  @Post('tasks/:taskId/cancel')
  async cancel(
    @CurrentUser() user: User,
    @Req() req: Request,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ): Promise<UpdateTaskSummary> {
    return this.updateService.cancel(user.id, getClientIp(req), taskId);
  }
}

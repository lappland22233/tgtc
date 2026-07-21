import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { AlertLevel } from '../common/entities/alert.entity';
import { AlertService } from './alert.service';

@Controller('admin/alerts')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AlertController {
  constructor(private alertService: AlertService) {}

  @Get()
  async getAlerts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('level') level?: string,
    @Query('acknowledged') acknowledged?: string,
  ) {
    return this.alertService.getAlerts({
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
      level: level && Object.values(AlertLevel).includes(level as AlertLevel)
        ? (level as AlertLevel)
        : undefined,
      acknowledged: acknowledged === 'true' ? true : acknowledged === 'false' ? false : undefined,
    });
  }

  @Get('unacknowledged')
  async getUnacknowledged() {
    return this.alertService.getUnacknowledged();
  }

  @Post(':id/acknowledge')
  async acknowledge(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    await this.alertService.acknowledge(id, user.id);
    return { message: '告警已确认' };
  }

  @Post('acknowledge-all')
  async acknowledgeAll(@CurrentUser() user: User) {
    const count = await this.alertService.acknowledgeAll(user.id);
    return { message: `已确认 ${count} 条告警` };
  }

  @Get('rules')
  async getRules() {
    return this.alertService.getRules();
  }

  @Put('rules')
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  async updateRules() {
    // Phase 4: 规则阈值修改留待后续版本。
    // 返回 501 明确表示未实现，避免误以为修改已生效。
    return { message: '规则修改功能将在后续版本中实现' };
  }
}

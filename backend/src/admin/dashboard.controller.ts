import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { DashboardService } from './dashboard.service';

@Controller('admin/dashboards')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get()
  async list(@CurrentUser() user: User) {
    return this.dashboardService.getByUser(user.id);
  }

  @Get('presets')
  async getPresets() {
    return this.dashboardService.getPresets();
  }

  @Post('presets/:name')
  async createFromPreset(
    @CurrentUser() user: User,
    @Param('name') name: string,
  ) {
    return this.dashboardService.createPreset(user.id, name);
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: User) {
    return this.dashboardService.getById(id, user.id);
  }

  @Post()
  async create(
    @CurrentUser() user: User,
    @Body() body: { name?: string; config?: any[]; isDefault?: boolean },
  ) {
    return this.dashboardService.create(
      user.id,
      body.name || '默认面板',
      body.config || [],
      body.isDefault || false,
    );
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() body: { config: any[] },
  ) {
    return this.dashboardService.update(id, user.id, body.config);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUser() user: User) {
    await this.dashboardService.delete(id, user.id);
    return { message: '仪表盘已删除' };
  }
}

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
import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { DashboardService } from './dashboard.service';

/** 单个仪表盘最多允许的 widget 数量 */
const MAX_WIDGETS = 50;

class CreateDashboardDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_WIDGETS)
  @IsObject({ each: true })
  config?: any[];

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

class UpdateDashboardDto {
  @IsArray()
  @ArrayMaxSize(MAX_WIDGETS)
  @IsObject({ each: true })
  config: any[];
}

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
    @Body() dto: CreateDashboardDto,
  ) {
    return this.dashboardService.create(
      user.id,
      dto.name || '默认面板',
      dto.config || [],
      dto.isDefault || false,
    );
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateDashboardDto,
  ) {
    return this.dashboardService.update(id, user.id, dto.config);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUser() user: User) {
    await this.dashboardService.delete(id, user.id);
    return { message: '仪表盘已删除' };
  }
}

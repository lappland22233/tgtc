import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { BanIPDto, BatchDeleteFilesDto, ConfigDto, BatchConfigDto, SmtpConfigDto, UploadConfigDto, AuthConfigDto } from './admin.dto';

@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(private adminService: AdminService) {}

  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  @Get('my-files-stats')
  async getMyFileStats(@CurrentUser() user: User) {
    return this.adminService.getAdminFileStats(user.id);
  }

  // System Config
  @Get('config')
  async getConfig() {
    return this.adminService.getConfig();
  }

  @Put('config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateConfig(
    @Body() dto: ConfigDto,
  ) {
    await this.adminService.updateConfig(dto.key, dto.value, dto.description);
    return { message: '配置已更新' };
  }

  @Put('config/batch')
  @Roles(UserRole.SUPER_ADMIN)
  async updateConfigs(
    @Body() dto: BatchConfigDto,
  ) {
    await this.adminService.updateConfigs(dto.configs);
    return { message: '配置已批量更新' };
  }

  // IP Management
  @Get('banned-ips')
  async getBannedIPs() {
    return this.adminService.getBannedIPs();
  }

  @Post('banned-ips')
  async banIP(
    @Body() dto: BanIPDto,
  ) {
    await this.adminService.banIP(
      dto.ip,
      dto.reason,
      dto.permanent !== false,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    );
    return { message: 'IP已封禁' };
  }

  @Delete('banned-ips/:ip')
  async unbanIP(@Param('ip') ip: string) {
    await this.adminService.unbanIP(ip);
    return { message: 'IP已解封' };
  }

  // File Management
  @Get('files')
  async getAllFiles(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.adminService.getAllFiles(Number(page), Number(limit));
  }

  @Delete('files/:id')
  @Roles(UserRole.SUPER_ADMIN)
  async deleteFile(@Param('id') id: string) {
    await this.adminService.deleteFile(id);
    return { message: '文件已删除' };
  }

  @Post('files/batch-delete')
  @Roles(UserRole.SUPER_ADMIN)
  async batchDeleteFiles(@Body() dto: BatchDeleteFilesDto) {
    await this.adminService.batchDeleteFiles(dto.ids);
    return { message: '文件已批量删除' };
  }

  // SMTP Config
  @Get('smtp')
  async getSMTPConfig() {
    return this.adminService.getSMTPConfig();
  }

  @Put('smtp')
  @Roles(UserRole.SUPER_ADMIN)
  async updateSMTPConfig(@Body() dto: SmtpConfigDto) {
    await this.adminService.updateSMTPConfig(dto);
    return { message: 'SMTP配置已更新' };
  }

  // Upload Config
  @Get('upload-config')
  async getUploadConfig() {
    return this.adminService.getUploadConfig();
  }

  @Put('upload-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateUploadConfig(@Body() dto: UploadConfigDto) {
    await this.adminService.updateUploadConfig(dto);
    return { message: '上传配置已更新' };
  }

  // Auth Config
  @Get('auth-config')
  async getAuthConfig() {
    return this.adminService.getAuthConfig();
  }

  @Put('auth-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateAuthConfig(@Body() dto: AuthConfigDto) {
    await this.adminService.updateAuthConfig(dto);
    return { message: '认证配置已更新' };
  }
}

import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';

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
  async updateConfig(
    @Body() data: { key: string; value: string; description?: string },
  ) {
    await this.adminService.updateConfig(data.key, data.value, data.description);
    return { message: '配置已更新' };
  }

  @Put('config/batch')
  async updateConfigs(
    @Body() data: { configs: { key: string; value: string; description?: string }[] },
  ) {
    await this.adminService.updateConfigs(data.configs);
    return { message: '配置已批量更新' };
  }

  // IP Management
  @Get('banned-ips')
  async getBannedIPs() {
    return this.adminService.getBannedIPs();
  }

  @Post('banned-ips')
  async banIP(
    @Body() data: { ip: string; reason?: string; permanent?: boolean; expiresAt?: string },
  ) {
    await this.adminService.banIP(
      data.ip,
      data.reason,
      data.permanent !== false,
      data.expiresAt ? new Date(data.expiresAt) : undefined,
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
  async batchDeleteFiles(@Body() data: { ids: string[] }) {
    await this.adminService.batchDeleteFiles(data.ids);
    return { message: '文件已批量删除' };
  }

  // SMTP Config
  @Get('smtp')
  async getSMTPConfig() {
    return this.adminService.getSMTPConfig();
  }

  @Put('smtp')
  @Roles(UserRole.SUPER_ADMIN)
  async updateSMTPConfig(@Body() data: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  }) {
    await this.adminService.updateSMTPConfig(data);
    return { message: 'SMTP配置已更新' };
  }

  // Upload Config
  @Get('upload-config')
  async getUploadConfig() {
    return this.adminService.getUploadConfig();
  }

  @Put('upload-config')
  async updateUploadConfig(@Body() data: {
    maxFileSize?: number;
    allowedFileTypes?: string;
  }) {
    await this.adminService.updateUploadConfig(data);
    return { message: '上传配置已更新' };
  }

  // Auth Config
  @Get('auth-config')
  async getAuthConfig() {
    return this.adminService.getAuthConfig();
  }

  @Put('auth-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateAuthConfig(@Body() data: {
    registrationEnabled?: boolean;
    emailVerificationEnabled?: boolean;
  }) {
    await this.adminService.updateAuthConfig(data);
    return { message: '认证配置已更新' };
  }
}

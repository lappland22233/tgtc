import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { BanIPDto, UnbanIPDto, BatchDeleteFilesDto, ConfigDto, BatchConfigDto, SmtpConfigDto, UploadConfigDto, AuthConfigDto, AccessLogQueryDto } from './admin.dto';

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
    @CurrentUser() user: User,
    @Body() dto: ConfigDto,
  ) {
    await this.adminService.updateConfig(user, dto.key, dto.value, dto.description);
    return { message: '配置已更新' };
  }

  @Put('config/batch')
  @Roles(UserRole.SUPER_ADMIN)
  async updateConfigs(
    @CurrentUser() user: User,
    @Body() dto: BatchConfigDto,
  ) {
    await this.adminService.updateConfigs(user, dto.configs);
    return { message: '配置已批量更新' };
  }

  // IP Management
  @Get('banned-ips')
  async getBannedIPs() {
    return this.adminService.getBannedIPs();
  }

  @Post('banned-ips')
  async banIP(
    @CurrentUser() user: User,
    @Body() dto: BanIPDto,
  ) {
    await this.adminService.banIP(
      user,
      dto.ip,
      dto.reason,
      dto.permanent !== false,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    );
    return { message: 'IP已封禁' };
  }

  @Delete('banned-ips/:ip')
  async unbanIP(
    @CurrentUser() user: User,
    @Param('ip') ip: string,
  ) {
    await this.adminService.unbanIP(user, ip);
    return { message: 'IP已解封' };
  }

  // 推荐方式：通过请求体传递 IP，避免 IPv6 冒号导致 URL 解析问题
  @Post('banned-ips/unban')
  async unbanIPByBody(
    @CurrentUser() user: User,
    @Body() dto: UnbanIPDto,
  ) {
    await this.adminService.unbanIP(user, dto.ip);
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
  async deleteFile(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    await this.adminService.deleteFile(user, id);
    return { message: '文件已删除' };
  }

  @Post('files/batch-delete')
  @Roles(UserRole.SUPER_ADMIN)
  async batchDeleteFiles(
    @CurrentUser() user: User,
    @Body() dto: BatchDeleteFilesDto,
  ) {
    await this.adminService.batchDeleteFiles(user, dto.ids);
    return { message: '文件已批量删除' };
  }

  // SMTP Config
  @Get('smtp')
  async getSMTPConfig() {
    return this.adminService.getSMTPConfig();
  }

  @Put('smtp')
  @Roles(UserRole.SUPER_ADMIN)
  async updateSMTPConfig(
    @CurrentUser() user: User,
    @Body() dto: SmtpConfigDto,
  ) {
    await this.adminService.updateSMTPConfig(user, dto);
    return { message: 'SMTP配置已更新' };
  }

  // Upload Config
  @Get('upload-config')
  async getUploadConfig() {
    return this.adminService.getUploadConfig();
  }

  @Put('upload-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateUploadConfig(
    @CurrentUser() user: User,
    @Body() dto: UploadConfigDto,
  ) {
    await this.adminService.updateUploadConfig(user, dto);
    return { message: '上传配置已更新' };
  }

  // Auth Config
  @Get('auth-config')
  async getAuthConfig() {
    return this.adminService.getAuthConfig();
  }

  @Put('auth-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateAuthConfig(
    @CurrentUser() user: User,
    @Body() dto: AuthConfigDto,
  ) {
    await this.adminService.updateAuthConfig(user, dto);
    return { message: '认证配置已更新' };
  }

  // ==================== 访问日志统计 ====================

  @Get('access-logs')
  @Roles(UserRole.SUPER_ADMIN)
  async getAccessLogs(@Query() query: AccessLogQueryDto) {
    return this.adminService.getAccessLogs(query);
  }

  @Get('access-logs/stats')
  @Roles(UserRole.SUPER_ADMIN)
  async getAccessLogStats(@Query('timeRange') timeRange?: string) {
    return this.adminService.getAccessLogStats(timeRange);
  }

  @Get('access-logs/trend')
  @Roles(UserRole.SUPER_ADMIN)
  async getAccessLogTrend(@Query('timeRange') timeRange?: string) {
    return this.adminService.getAccessLogTrend(timeRange);
  }

  @Get('audit-logs')
  @Roles(UserRole.SUPER_ADMIN)
  async getAuditLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('timeRange') timeRange?: string,
  ) {
    return this.adminService.getAuditLogs({
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
      action,
      userId,
      timeRange,
    });
  }
}

import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Res, BadRequestException, HttpCode, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminService } from './admin.service';
import { FileVerifyService } from './file-verify.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { BanIPDto, UnbanIPDto, BatchDeleteFilesDto, ConfigDto, BatchConfigDto, SmtpConfigDto, SmtpTestDto, UploadConfigDto, AuthConfigDto, AccessLogQueryDto, SecurityConfigBatchDto, FileVerifyDto, StalePathCleanupDto, AdminFilesQueryDto } from './admin.dto';
import { TopFilesQueryDto, TopPathsQueryDto, StatusByPathQueryDto, AbnormalIpsQueryDto, DateRangeQueryDto, RefererAnalysisQueryDto, UserAgentAnalysisQueryDto, BandwidthQueryDto, FileTypeQueryDto } from './admin-stats.dto';
import { CacheConfigDto } from './dto/cache-config.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
export class AdminController {
  constructor(
    private adminService: AdminService,
    private fileVerifyService: FileVerifyService,
  ) {}

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
  // G7-07：page/limit 走 DTO 校验（@Type Number + @Min/@Max，limit ≤ 100），
  // 排序字段/方向白名单由 DTO @IsIn 统一约束，替代裸 Number() 与手写白名单。
  @Get('files')
  async getAllFiles(@Query() query: AdminFilesQueryDto) {
    return this.adminService.getAllFiles(
      query.page ?? 1,
      query.limit ?? 20,
      query.keyword,
      query.userId,
      query.sortBy,
      query.sortOrder,
      query.cursor,
    );
  }

  @Delete('files/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async deleteFile(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const result = await this.adminService.deleteFile(user, id);
    return result;
  }

  @Post('files/batch-delete')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async batchDeleteFiles(
    @CurrentUser() user: User,
    @Body() dto: BatchDeleteFilesDto,
  ) {
    await this.adminService.batchDeleteFiles(user, dto.ids);
    return { message: '文件已批量删除' };
  }

  /**
   * 创建文件体检异步任务：校验 ready 文件 Telegram file_id 是否仍有效。
   * 默认 dry-run 仅统计；显式 apply 才标记 error / 回填 telegramFilePath。
   * 立即返回 taskId（HTTP 202），后台通过 Bull 队列异步执行，可查询任务进度。
   */
  @Post('files/verify')
  @HttpCode(202)
  @Roles(UserRole.SUPER_ADMIN)
  async createFileVerifyTask(@CurrentUser() user: User, @Body() dto: FileVerifyDto) {
    return this.fileVerifyService.createTask(user, {
      mode: dto.mode,
      allReady: dto.allReady,
      limit: dto.limit,
      concurrency: dto.concurrency,
    });
  }

  /** 获取当前活动体检任务（queued/running），无任务时返回 null。注意此路由必须先于 :taskId 定义。 */
  @Get('files/verify/active')
  @Roles(UserRole.SUPER_ADMIN)
  async getActiveFileVerifyTask() {
    const task = await this.fileVerifyService.getActiveTask();
    return { task: task ? this.fileVerifyService.toView(task) : null };
  }

  /** 按 taskId 查询体检任务状态、进度与最终结果 */
  @Get('files/verify/:taskId')
  @Roles(UserRole.SUPER_ADMIN)
  async getFileVerifyTask(@Param('taskId') taskId: string) {
    const task = await this.fileVerifyService.getTask(taskId);
    if (!task) throw new NotFoundException('体检任务不存在');
    return { task: this.fileVerifyService.toView(task) };
  }

  /**
   * 存量旧路径清理：仅 SUPER_ADMIN。
   * dry-run 统计命中旧 /data/cb/tgtc-beta/ 前缀的 telegramFilePath 数量（不修改）；
   * apply 将匹配记录的 telegramFilePath 清空为 NULL（幂等），不改变文件 status。
   */
  @Post('files/stale-paths/cleanup')
  @Roles(UserRole.SUPER_ADMIN)
  async cleanupStalePaths(@CurrentUser() user: User, @Body() dto: StalePathCleanupDto) {
    return this.adminService.cleanupStalePaths(user, dto.mode ?? 'dry-run');
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

  // 测试发送使用当前生效配置（含刚保存未重启的 DB 配置），先自检连通性再发送
  @Post('smtp/test')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async sendTestSMTPMail(
    @CurrentUser() user: User,
    @Body() dto: SmtpTestDto,
  ) {
    await this.adminService.sendTestSMTPMail(user, dto.recipient);
    return { message: '测试邮件发送成功，请检查收件箱' };
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

  // File Cache Config
  @Get('cache-config')
  @Roles(UserRole.SUPER_ADMIN)
  async getCacheConfig() {
    return this.adminService.getCacheConfig();
  }

  @Put('cache-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateCacheConfig(
    @CurrentUser() user: User,
    @Body() dto: CacheConfigDto,
  ) {
    await this.adminService.updateCacheConfig(user, dto);
    return { message: '缓存配置已更新' };
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

  // ==================== Phase 2: 来源分析 ====================

  @Get('source-analysis/referer')
  @Roles(UserRole.SUPER_ADMIN)
  async getRefererAnalysis(@Query() query: RefererAnalysisQueryDto) {
    return this.adminService.getRefererAnalysis(query);
  }

  @Get('source-analysis/user-agent')
  @Roles(UserRole.SUPER_ADMIN)
  async getUserAgentAnalysis(@Query() query: UserAgentAnalysisQueryDto) {
    return this.adminService.getUserAgentAnalysis(query);
  }

  // ==================== Phase 3: 活动与消耗分析 ====================

  @Get('user-activity/stats')
  @Roles(UserRole.SUPER_ADMIN)
  async getUserActivityStats(@Query() query: DateRangeQueryDto) {
    return this.adminService.getUserActivityStats(query);
  }

  @Get('bandwidth/top-files')
  @Roles(UserRole.SUPER_ADMIN)
  async getBandwidthAnalysis(@Query() query: BandwidthQueryDto) {
    return this.adminService.getBandwidthAnalysis(query);
  }

  @Get('file-type-stats')
  @Roles(UserRole.SUPER_ADMIN)
  async getFileTypeStats(@Query() query: FileTypeQueryDto) {
    return this.adminService.getFileTypeStats(query);
  }

  // ==================== Phase 7: 数据导出 ====================
  @Get('export')
  @Roles(UserRole.SUPER_ADMIN)
  async exportData(
    @CurrentUser() user: User,
    @Query('format') format: string,
    @Query('timeRange') timeRange: string,
    @Query('type') type: string,
    @Res() res: any,
  ) {
    // 白名单校验，防止非法参数
    const validFormats = ['csv', 'json'];
    const validTypes = ['access-logs', 'top-files', 'bans', 'alerts'];
    const validTimeRanges = ['1h', '24h', '7d', '30d'];
    if (format && !validFormats.includes(format)) {
      throw new BadRequestException(`不支持的导出格式: ${format}`);
    }
    if (type && !validTypes.includes(type)) {
      throw new BadRequestException(`不支持的导出类型: ${type}`);
    }
    if (timeRange && !validTimeRanges.includes(timeRange)) {
      throw new BadRequestException(`不支持的时间范围: ${timeRange}`);
    }
    const result = await this.adminService.exportData(user, {
      format: (format as 'csv' | 'json') || 'csv',
      timeRange: timeRange || '7d',
      type: (type as 'access-logs' | 'top-files' | 'bans' | 'alerts') || 'access-logs',
    });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(Buffer.from(result.data, 'utf-8'));
  }

  // ==================== Phase 7: 同比环比分析 ====================
  @Get('comparison')
  @Roles(UserRole.SUPER_ADMIN)
  async getComparison(@Query('timeRange') timeRange?: string) {
    return this.adminService.getComparison(timeRange || '7d');
  }

  // ==================== 访问日志统计 ====================

  // 注意：更具体的路由必须在 GET access-logs 之前定义，避免路由冲突
  @Get('access-logs/top-files')
  @Roles(UserRole.SUPER_ADMIN)
  async getTopFiles(@Query() query: TopFilesQueryDto) {
    return this.adminService.getTopFiles(query);
  }

  @Get('access-logs/top-paths')
  @Roles(UserRole.SUPER_ADMIN)
  async getTopPaths(@Query() query: TopPathsQueryDto) {
    return this.adminService.getTopPaths(query);
  }

  @Get('access-logs/latency')
  @Roles(UserRole.SUPER_ADMIN)
  async getLatencyStats(@Query() query: DateRangeQueryDto) {
    return this.adminService.getLatencyStats(query);
  }

  @Get('access-logs/status-by-path')
  @Roles(UserRole.SUPER_ADMIN)
  async getStatusByPath(@Query() query: StatusByPathQueryDto) {
    return this.adminService.getStatusByPath(query);
  }

  @Get('access-logs/download-stats')
  @Roles(UserRole.SUPER_ADMIN)
  async getDownloadStats(@Query() query: DateRangeQueryDto) {
    return this.adminService.getDownloadStats(query);
  }

  @Get('access-logs/abnormal-ips')
  @Roles(UserRole.SUPER_ADMIN)
  async getAbnormalIps(@Query() query: AbnormalIpsQueryDto) {
    return this.adminService.getAbnormalIps(query);
  }

  @Get('ban-stats')
  @Roles(UserRole.SUPER_ADMIN)
  async getBanStats() {
    return this.adminService.getBanStats();
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

  /**
   * 注意：此路由必须放置在 access-logs/stats、access-logs/trend 等更具体的路由之后，
   * 保证具体路由优先匹配（与上方注释保持一致）。
   */
  @Get('access-logs')
  @Roles(UserRole.SUPER_ADMIN)
  async getAccessLogs(@Query() query: AccessLogQueryDto) {
    return this.adminService.getAccessLogs(query);
  }

  @Get('audit-logs/email-verification-stats')
  @Roles(UserRole.SUPER_ADMIN)
  async getEmailVerificationStats(@Query('timeRange') timeRange?: string) {
    return this.adminService.getEmailVerificationStats(timeRange);
  }

  @Get('audit-logs')
  @Roles(UserRole.SUPER_ADMIN)
  async getAuditLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('timeRange') timeRange?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.getAuditLogs({
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
      action,
      userId,
      timeRange,
      status,
    });
  }

  // ==================== 安全规则配置 ====================

  @Get('security-config')
  @Roles(UserRole.SUPER_ADMIN)
  async getSecurityConfig() {
    return this.adminService.getSecurityConfig();
  }

  @Put('security-config')
  @Roles(UserRole.SUPER_ADMIN)
  async updateSecurityConfig(
    @CurrentUser() user: User,
    @Body() dto: SecurityConfigBatchDto,
  ) {
    await this.adminService.updateSecurityConfig(user, dto.configs);
    return { message: '安全配置已更新' };
  }
}

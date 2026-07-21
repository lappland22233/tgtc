import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DashboardConfig } from '../common/entities/dashboard-config.entity';

/** 单个仪表盘最多允许的 widget 数量 */
const MAX_WIDGETS = 50;
/** config 序列化后的最大字节数（64 KB），防止存储膨胀与超深嵌套 */
const MAX_CONFIG_BYTES = 64 * 1024;

/** 3 套预设仪表盘模板 */
export const PRESET_TEMPLATES: Record<string, any[]> = {
  '全览面板': [
    { i: 'total-requests', x: 0, y: 0, w: 3, h: 2, type: 'metric-card', config: { metric: 'totalRequests', label: '总请求数', endpoint: '/admin/access-logs/stats', format: 'number' } },
    { i: 'bandwidth', x: 3, y: 0, w: 3, h: 2, type: 'metric-card', config: { metric: 'totalBandwidth', label: '带宽消耗', endpoint: '/admin/access-logs/stats', format: 'size' } },
    { i: 'uv', x: 6, y: 0, w: 3, h: 2, type: 'metric-card', config: { metric: 'uniqueVisitors', label: '独立访客', endpoint: '/admin/access-logs/stats', format: 'number' } },
    { i: 'qps', x: 9, y: 0, w: 3, h: 2, type: 'metric-card', config: { metric: 'peakQPS', label: '峰值 QPS', endpoint: '/admin/access-logs/stats', format: 'number' } },
    { i: 'trend', x: 0, y: 2, w: 8, h: 4, type: 'chart-line', config: { endpoint: '/admin/access-logs/trend', title: '流量趋势' } },
    { i: 'status', x: 8, y: 2, w: 4, h: 4, type: 'chart-pie', config: { endpoint: '/admin/access-logs/stats', field: 'statusDistribution', title: '状态码分布' } },
  ],
  '安全面板': [
    { i: 'totalBanned', x: 0, y: 0, w: 4, h: 2, type: 'metric-card', config: { metric: 'totalBanned', label: '总封禁数', endpoint: '/admin/ban-stats', format: 'number' } },
    { i: 'activeBans', x: 4, y: 0, w: 4, h: 2, type: 'metric-card', config: { metric: 'activeBans', label: '活跃封禁', endpoint: '/admin/ban-stats', format: 'number' } },
    { i: 'unbanRatio', x: 8, y: 0, w: 4, h: 2, type: 'metric-card', config: { metric: 'unbanRatio', label: '解封率', endpoint: '/admin/ban-stats', format: 'percent' } },
    { i: 'abnormalIps', x: 0, y: 2, w: 12, h: 6, type: 'table', config: { endpoint: '/admin/access-logs/abnormal-ips', title: '异常 IP', limit: 10 } },
  ],
  '文件面板': [
    { i: 'topFilesAccess', x: 0, y: 0, w: 12, h: 5, type: 'table', config: { endpoint: '/admin/access-logs/top-files', title: '热门文件', limit: 10, params: { sortBy: 'accessCount' } } },
    { i: 'topFilesBandwidth', x: 0, y: 5, w: 12, h: 5, type: 'table', config: { endpoint: '/admin/access-logs/top-files', title: '带宽消耗排行', limit: 10, params: { sortBy: 'bandwidth' } } },
  ],
};

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(DashboardConfig)
    private dashboardRepo: Repository<DashboardConfig>,
  ) {}

  async getByUser(userId: string): Promise<DashboardConfig[]> {
    return this.dashboardRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  async getById(id: string, userId: string): Promise<DashboardConfig> {
    const config = await this.dashboardRepo.findOne({ where: { id, userId } });
    if (!config) throw new NotFoundException('仪表盘不存在');
    return config;
  }

  async create(userId: string, name: string, config: any = [], isDefault = false): Promise<DashboardConfig> {
    this.assertValidConfig(config);

    // 如果设为默认，先取消其他默认
    if (isDefault) {
      await this.dashboardRepo.update({ userId, isDefault: true }, { isDefault: false });
    }

    const dashboard = this.dashboardRepo.create({
      userId,
      name: name || '默认面板',
      config: config.length > 0 ? config : [],
      isDefault,
    });
    return this.dashboardRepo.save(dashboard);
  }

  async update(id: string, userId: string, config: any): Promise<DashboardConfig> {
    this.assertValidConfig(config);

    const dashboard = await this.getById(id, userId);
    dashboard.config = config;
    return this.dashboardRepo.save(dashboard);
  }

  /**
   * 服务层兜底校验：config 必须为数组、widget 数量与序列化大小受限，
   * 防止任意深度/大小的 JSON 造成存储膨胀或存储型 XSS 载荷入库。
   */
  private assertValidConfig(config: any): void {
    if (!Array.isArray(config)) {
      throw new BadRequestException('仪表盘 config 必须为数组');
    }
    if (config.length > MAX_WIDGETS) {
      throw new BadRequestException(`仪表盘 widget 数量不能超过 ${MAX_WIDGETS}`);
    }
    let byteLength: number;
    try {
      byteLength = Buffer.byteLength(JSON.stringify(config), 'utf8');
    } catch {
      throw new BadRequestException('仪表盘 config 无法序列化');
    }
    if (byteLength > MAX_CONFIG_BYTES) {
      throw new BadRequestException(`仪表盘 config 超过大小上限 (${MAX_CONFIG_BYTES} bytes)`);
    }
  }

  async delete(id: string, userId: string): Promise<void> {
    const dashboard = await this.getById(id, userId);
    await this.dashboardRepo.remove(dashboard);
  }

  async createPreset(userId: string, templateName: string): Promise<DashboardConfig> {
    const config = PRESET_TEMPLATES[templateName];
    if (!config) throw new NotFoundException(`模板 "${templateName}" 不存在`);
    return this.create(userId, templateName, config, false);
  }

  getPresets() {
    return Object.keys(PRESET_TEMPLATES).map((name) => ({
      name,
      widgetCount: PRESET_TEMPLATES[name].length,
    }));
  }
}

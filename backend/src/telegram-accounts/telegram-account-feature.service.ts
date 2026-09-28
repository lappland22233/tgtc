import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigCacheService } from '../common/services/config-cache.service';

/** 运行时配置键（面板热更新；env 只作为首次默认值） */
export const ACCOUNT_FEATURE_KEYS = {
  accountPool: 'TELEGRAM_ACCOUNT_POOL_FEATURE_ENABLED',
  mirror: 'TELEGRAM_MIRROR_FEATURE_ENABLED',
} as const;

export type FeatureValueSource = 'runtime' | 'env' | 'forced_disabled' | 'default';

export interface TelegramAccountFeatureState {
  accountPoolEnabled: boolean;
  mirrorEnabled: boolean;
  accountPoolSource: FeatureValueSource;
  mirrorSource: FeatureValueSource;
  /** 紧急止血：env 强制关闭时面板无法开启 */
  accountPoolForceDisabled: boolean;
  mirrorForceDisabled: boolean;
}

/**
 * 账号池与镜像的三层开关（全局账号池 / 镜像功能 / 单账号与单规则）。
 *
 * 设计要点（与 `.codebuddy/待更新.md` §11.2 一致）：
 * - **以数据库运行时配置为主**：管理员热切换写入 `SystemConfig` 并审计，秒级生效；
 * - **env 只保留两类语义**：首次默认值（`TELEGRAM_ACCOUNT_POOL_ENABLED` /
 *   `TELEGRAM_MIRROR_ENABLED`）与紧急止血（`*_FORCE_DISABLED=true`）；
 * - 强制关闭不可被面板覆盖：`setXxxEnabled(true)` 直接 400，避免误操作。
 */
@Injectable()
export class TelegramAccountFeatureService {
  private readonly logger = new Logger(TelegramAccountFeatureService.name);

  constructor(
    private readonly configCache: ConfigCacheService,
    private readonly configService: ConfigService,
  ) {}

  async getState(): Promise<TelegramAccountFeatureState> {
    const accountPoolForceDisabled = this.isTruthy(
      this.configService.get<string>('TELEGRAM_ACCOUNT_POOL_FORCE_DISABLED'),
    );
    const mirrorForceDisabled = this.isTruthy(
      this.configService.get<string>('TELEGRAM_MIRROR_FORCE_DISABLED'),
    );

    const [accountPool, mirror] = await Promise.all([
      this.readSwitch(ACCOUNT_FEATURE_KEYS.accountPool, 'TELEGRAM_ACCOUNT_POOL_ENABLED', accountPoolForceDisabled),
      this.readSwitch(ACCOUNT_FEATURE_KEYS.mirror, 'TELEGRAM_MIRROR_ENABLED', mirrorForceDisabled),
    ]);

    return {
      accountPoolEnabled: accountPool.enabled,
      mirrorEnabled: mirror.enabled,
      accountPoolSource: accountPool.source,
      mirrorSource: mirror.source,
      accountPoolForceDisabled,
      mirrorForceDisabled,
    };
  }

  async isAccountPoolEnabled(): Promise<boolean> {
    return (await this.getState()).accountPoolEnabled;
  }

  async isMirrorEnabled(): Promise<boolean> {
    return (await this.getState()).mirrorEnabled;
  }

  async setAccountPoolEnabled(enabled: boolean): Promise<void> {
    await this.writeSwitch(
      ACCOUNT_FEATURE_KEYS.accountPool,
      'TELEGRAM_ACCOUNT_POOL_FORCE_DISABLED',
      '账号池总开关（运行时，关闭只阻止新任务）',
      enabled,
    );
  }

  async setMirrorEnabled(enabled: boolean): Promise<void> {
    await this.writeSwitch(
      ACCOUNT_FEATURE_KEYS.mirror,
      'TELEGRAM_MIRROR_FORCE_DISABLED',
      '文件镜像总开关（运行时，关闭只阻止新任务）',
      enabled,
    );
  }

  private async readSwitch(
    key: string,
    envKey: string,
    forceDisabled: boolean,
  ): Promise<{ enabled: boolean; source: FeatureValueSource }> {
    const envDefault = this.isTruthy(this.configService.get<string>(envKey));
    const runtime = await this.configCache.get(key, '');
    const normalized = runtime.trim().toLowerCase();
    let enabled: boolean;
    let source: FeatureValueSource;
    if (normalized === 'true' || normalized === 'false') {
      enabled = normalized === 'true';
      source = 'runtime';
    } else {
      enabled = envDefault;
      source = envDefault ? 'env' : 'default';
    }
    if (forceDisabled) {
      return { enabled: false, source: 'forced_disabled' };
    }
    return { enabled, source };
  }

  private async writeSwitch(
    key: string,
    forceDisabledEnvKey: string,
    description: string,
    enabled: boolean,
  ): Promise<void> {
    if (enabled && this.isTruthy(this.configService.get<string>(forceDisabledEnvKey))) {
      throw new BadRequestException(
        `环境变量 ${forceDisabledEnvKey}=true 已强制关闭该能力（紧急止血），面板无法开启；`
        + '如需恢复请先由运维移除该环境变量并重启服务',
      );
    }
    await this.configCache.set(key, enabled ? 'true' : 'false', description);
    this.logger.log(`能力开关已热更新：${key}=${enabled ? 'true' : 'false'}`);
  }

  private isTruthy(raw: string | undefined): boolean {
    return (raw || '').trim().toLowerCase() === 'true';
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isStableVersion, parseSemver } from './semver';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** 无法读取或内容非法时的统一哨兵值；不泄漏文件系统细节。 */
export const VERSION_UNKNOWN = 'unknown';

export function resolveVersionFile(): string {
  // 发行包布局：backend/dist/<module>/*.js → 上三级为发行根（VERSION 所在目录）。
  // 源码布局：backend/src/<module> → 上三级为仓库根。
  return resolve(__dirname, '..', '..', '..', 'VERSION');
}

/**
 * 版本仅从随发行包固定的根目录 VERSION 读取。拒绝异常内容，避免把任意文件
 * 内容经公开 API 暴露；读取失败同样不泄漏文件系统细节。
 */
export function readReleaseVersion(versionFile = resolveVersionFile()): string {
  try {
    const version = readFileSync(versionFile, 'utf8').trim();
    return SEMVER_PATTERN.test(version) ? version : VERSION_UNKNOWN;
  } catch {
    return VERSION_UNKNOWN;
  }
}

/**
 * 全局唯一的运行版本读取源。
 *
 * health、public-config、update 模块都必须经由本服务取版本，
 * 保证对外展示、更新比较与升级目标校验使用同一事实来源。
 * 成功读取后缓存（进程内版本不可变）；失败时保持 unknown 并允许后续重试。
 */
@Injectable()
export class VersionService {
  private readonly logger = new Logger(VersionService.name);
  private cachedVersion: string | null = null;

  getCurrentVersion(): string {
    if (this.cachedVersion) return this.cachedVersion;
    const version = readReleaseVersion();
    if (version !== VERSION_UNKNOWN) {
      this.cachedVersion = version;
    } else {
      // unknown 不缓存：发行包异常可能是临时挂载问题，后续调用允许恢复。
      this.logger.warn('无法从根目录 VERSION 读取有效运行版本。');
    }
    return version;
  }

  isVersionKnown(): boolean {
    return this.getCurrentVersion() !== VERSION_UNKNOWN;
  }

  /** 当前运行版本是否为稳定版（无预发布后缀）。 */
  isCurrentVersionStable(): boolean {
    return isStableVersion(this.getCurrentVersion());
  }

  /** 当前版本是否严格高于目标版本（用于安装端防降级二次确认）。 */
  isOlderThan(targetVersion: string): boolean {
    const current = this.getCurrentVersion();
    const parsedCurrent = parseSemver(current);
    const parsedTarget = parseSemver(targetVersion);
    if (!parsedCurrent || !parsedTarget) return false;
    if (parsedTarget.major > parsedCurrent.major) return true;
    if (parsedTarget.major < parsedCurrent.major) return false;
    if (parsedTarget.minor > parsedCurrent.minor) return true;
    if (parsedTarget.minor < parsedCurrent.minor) return false;
    return parsedTarget.patch > parsedCurrent.patch;
  }
}

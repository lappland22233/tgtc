import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** 无法读取或内容非法时的统一哨兵值；不泄漏文件系统细节。 */
export const VERSION_UNKNOWN = 'unknown';

export function resolveVersionFile(): string {
  return resolve(__dirname, '..', '..', '..', 'VERSION');
}

/** 只对外提供根目录 VERSION 中的合法版本号。 */
export function readReleaseVersion(versionFile = resolveVersionFile()): string {
  try {
    const version = readFileSync(versionFile, 'utf8').trim();
    return SEMVER_PATTERN.test(version) ? version : VERSION_UNKNOWN;
  } catch {
    return VERSION_UNKNOWN;
  }
}

/** 健康检查和公开配置共享版本。首次读取失败时允许重试。 */
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
      this.logger.warn('无法从根目录 VERSION 读取有效运行版本。');
    }
    return version;
  }
}

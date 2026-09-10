import { ForbiddenException } from '@nestjs/common';
import { hasAdminPrivileges } from '../auth-context';
import type { User } from '../entities/user.entity';

/**
 * 文件读写权限判定（M6 拆分：从 FileService 的私有方法上移为共用工具）。
 *
 * 语义约定（勿改动，安全相关）：
 * - 仅文件所有者与管理员可读写；
 * - API Key 认证请求一律视为普通用户（owner-only），即使关联账号是管理员
 *   —— 该约束由 `hasAdminPrivileges` 统一表达，调用方不得自行放宽。
 *
 * 抽出的原因：访问策略/密码/封禁域拆为独立服务后，两侧都需要同一判定，
 * 避免复制实现造成安全语义漂移。
 */

/** 权限判定所需的最小文件形状 */
export interface FileOwnership {
  uploaderId: string;
}

/** 读权限：失败抛 403 */
export async function assertFileReadable(file: FileOwnership, user: User): Promise<void> {
  if (file.uploaderId !== user.id && !hasAdminPrivileges(user)) {
    throw new ForbiddenException('无权访问此文件');
  }
}

/** 写权限：失败抛 403 */
export function assertFileWritable(file: FileOwnership, user: User): void {
  if (file.uploaderId !== user.id && !hasAdminPrivileges(user)) {
    throw new ForbiddenException('无权修改此文件');
  }
}

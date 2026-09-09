import { User, UserRole } from './entities/user.entity';

/**
 * API Key 认证上下文。
 *
 * 设计要点（owner-only 边界）：
 * - API Key 请求解析出的用户对象会附加不可枚举的 apiKeyContext 标记；
 * - 即使关联账号具备管理员角色，带此标记的用户也一律按普通用户处理，
 *   文件/文件夹服务中所有「管理员可越权访问他人资源」的分支必须通过
 *   hasAdminPrivileges() 判断，而不是直接读取 user.role。
 * - 标记不可枚举，避免意外出现在 JSON 序列化、日志或响应体中。
 */
export interface ApiKeyContextInfo {
  keyId: string;
  keyName: string;
  /** 密钥展示前缀（明文不可恢复，仅用于日志与界面识别） */
  prefix: string;
}

const API_KEY_CONTEXT = Symbol('apiKeyContext');

type UserWithApiKeyContext = User & { [API_KEY_CONTEXT]?: ApiKeyContextInfo };

/** 在认证成功的用户对象上附加 API Key 上下文标记。 */
export function attachApiKeyContext<T extends User>(user: T, info: ApiKeyContextInfo): T {
  Object.defineProperty(user, API_KEY_CONTEXT, {
    value: info,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return user;
}

/** 读取 API Key 上下文；非 API Key 请求返回 null。 */
export function getApiKeyContext(user: User | undefined | null): ApiKeyContextInfo | null {
  if (!user || typeof user !== 'object') return null;
  return (user as UserWithApiKeyContext)[API_KEY_CONTEXT] ?? null;
}

/**
 * 统一的管理员越权判断。
 * API Key 认证请求一律返回 false（owner-only），杜绝密钥借用管理员权限跨账号操作。
 */
export function hasAdminPrivileges(user: User | undefined | null): boolean {
  if (!user) return false;
  if (getApiKeyContext(user)) return false;
  return user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;
}

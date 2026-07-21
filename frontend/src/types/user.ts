export type UserRole = 'user' | 'admin' | 'super_admin';

/**
 * 当前登录用户信息（/auth/me 等场景）。
 * 不包含登录 IP 等敏感字段，避免在普通用户可见接口中泄露 PII。
 */
export interface User {
  id: string;
  email: string;
  role: UserRole;
  emailVerified: boolean;
  isBanned: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * 管理端用户信息（admin 列表/详情接口）。
 * 含 lastLoginIP 等敏感字段，仅可在管理端视图使用，切勿暴露给普通用户。
 */
export interface AdminUser extends User {
  lastLoginIP: string | null;
}

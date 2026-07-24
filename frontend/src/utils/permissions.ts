import type { UserRole } from '../types/user';

export const ALL_ROLES: readonly UserRole[] = ['user', 'admin', 'super_admin'];
export const ADMIN_ROLES: readonly UserRole[] = ['admin', 'super_admin'];
export const SUPER_ADMIN_ROLES: readonly UserRole[] = ['super_admin'];

/** 页面访问权限唯一来源：路由守卫和所有导航入口必须共同读取此表。 */
export const PAGE_ROLES: Readonly<Record<string, readonly UserRole[]>> = {
  '/dashboard': ALL_ROLES,
  '/files': ALL_ROLES,
  '/shares': ALL_ROLES,
  '/settings': ALL_ROLES,
  '/admin': ADMIN_ROLES,
  '/admin/dashboard-customizer': ADMIN_ROLES,
  '/admin/users': ADMIN_ROLES,
  '/admin/files': ADMIN_ROLES,
  '/admin/config': SUPER_ADMIN_ROLES,
  '/admin/access-logs': SUPER_ADMIN_ROLES,
  '/admin/security': SUPER_ADMIN_ROLES,
  '/admin/user-activity': SUPER_ADMIN_ROLES,
  '/admin/audit-logs': SUPER_ADMIN_ROLES,
  '/admin/telemetry': SUPER_ADMIN_ROLES,
};

export function hasAnyRole(
  role: UserRole | null | undefined,
  allowedRoles: readonly UserRole[],
): boolean {
  return !!role && allowedRoles.includes(role);
}

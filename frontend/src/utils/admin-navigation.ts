import type { UserRole } from '@/types/user';
import { hasAnyRole, PAGE_ROLES } from './permissions';

const adminNavGroups = [
  { label: '概览', links: [{ to: '/admin', label: '管理概览' }] },
  { label: '用户与文件', links: [
    { to: '/admin/users', label: '用户管理' },
    { to: '/admin/files', label: '文件管理' },
  ] },
  { label: '监控与审计', links: [
    { to: '/admin/access-logs', label: '访问统计' },
    { to: '/admin/security', label: '安全监控' },
    { to: '/admin/user-activity', label: '用户活跃' },
    { to: '/admin/audit-logs', label: '操作审计' },
  ] },
  { label: '存储与 Bot', links: [
    { to: '/admin/bot-operations', label: 'Bot 收件管理' },
    { to: '/admin/telegram-accounts', label: 'Telegram 账号池' },
    { to: '/admin/storage-backends', label: '存储后端' },
  ] },
  { label: '设置', links: [{ to: '/admin/config', label: '系统配置' }] },
];

export function getAdminNavGroups(role: UserRole) {
  return adminNavGroups
    .map(({ label, links }) => ({ label, links: links.filter(({ to }) => hasAnyRole(role, PAGE_ROLES[to] ?? [])) }))
    .filter(({ links }) => links.length > 0);
}

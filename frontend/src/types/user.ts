export type UserRole = 'user' | 'admin' | 'super_admin';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  emailVerified: boolean;
  isBanned: boolean;
  lastLoginIP: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

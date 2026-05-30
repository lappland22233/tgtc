export interface AdminStats {
  totalUsers: number;
  totalFiles: number;
  totalStorage: number;
  bannedUsers: number;
  activeUsers: number;
}

export interface UserStats {
  fileCount: number;
  totalSize: number;
}

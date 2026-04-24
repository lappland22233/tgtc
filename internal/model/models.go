package model

import (
	"database/sql"
	"fmt"
	"time"
)

// ============================================
// 用户相关模型
// ============================================

// UserRole 用户角色枚举
type UserRole string

const (
	RoleSuperAdmin UserRole = "super_admin"
	RoleAdmin      UserRole = "admin"
	RoleOperator   UserRole = "operator"
)

// UserStatus 用户状态枚举
type UserStatus string

const (
	UserStatusActive   UserStatus = "active"
	UserStatusDisabled UserStatus = "disabled"
)

// User 用户模型
type User struct {
	ID           int64        `db:"id" json:"id"`
	Username     string       `db:"username" json:"username"`
	PasswordHash string       `db:"password_hash" json:"-"`
	Role         UserRole     `db:"role" json:"role"`
	Status       UserStatus   `db:"status" json:"status"`
	LastLoginAt  sql.NullTime `db:"last_login_at" json:"last_login_at,omitempty"`
	LastLoginIP  sql.NullString `db:"last_login_ip" json:"last_login_ip,omitempty"`
	LoginCount   int          `db:"login_count" json:"login_count"`
	CreatedAt    time.Time    `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time    `db:"updated_at" json:"updated_at"`
}

// UserResponse 用户响应模型（敏感信息已移除）
type UserResponse struct {
	ID          int64      `json:"id"`
	Username    string     `json:"username"`
	Role        UserRole   `json:"role"`
	Status      UserStatus `json:"status"`
	LastLoginAt *time.Time `json:"last_login_at,omitempty"`
	LoginCount  int        `json:"login_count"`
	CreatedAt   time.Time  `json:"created_at"`
}

// ToResponse 转换为响应模型
func (u *User) ToResponse() *UserResponse {
	resp := &UserResponse{
		ID:         u.ID,
		Username:   u.Username,
		Role:       u.Role,
		Status:     u.Status,
		LoginCount: u.LoginCount,
		CreatedAt:  u.CreatedAt,
	}
	if u.LastLoginAt.Valid {
		resp.LastLoginAt = &u.LastLoginAt.Time
	}
	return resp
}

// CanManageUsers 检查用户是否有管理其他用户的权限
func (u *User) CanManageUsers() bool {
	return u.Role == RoleSuperAdmin
}

// CanManageFiles 检查用户是否有管理文件的权限
func (u *User) CanManageFiles() bool {
	return u.Role == RoleSuperAdmin || u.Role == RoleAdmin
}

// CanManageBan 检查用户是否有管理IP封禁的权限
func (u *User) CanManageBan() bool {
	return u.Role == RoleSuperAdmin || u.Role == RoleAdmin
}

// ============================================
// 操作日志相关模型
// ============================================

// AdminLogAction 操作类型
type AdminLogAction string

const (
	ActionLogin          AdminLogAction = "login"
	ActionLogout         AdminLogAction = "logout"
	ActionCreateUser     AdminLogAction = "create_user"
	ActionUpdateUser     AdminLogAction = "update_user"
	ActionDeleteUser     AdminLogAction = "delete_user"
	ActionChangePassword AdminLogAction = "change_password"
	ActionBanIP          AdminLogAction = "ban_ip"
	ActionUnbanIP        AdminLogAction = "unban_ip"
	ActionDeleteFile      AdminLogAction = "delete_file"
	ActionUpdateConfig   AdminLogAction = "update_config"
)

// AdminLog 操作日志模型
type AdminLog struct {
	ID        int64          `db:"id" json:"id"`
	UserID    int64          `db:"user_id" json:"user_id"`
	Username  string         `db:"username" json:"username"`
	Action    AdminLogAction `db:"action" json:"action"`
	Target    sql.NullString `db:"target" json:"target,omitempty"`
	IP        sql.NullString `db:"ip" json:"ip,omitempty"`
	UserAgent sql.NullString `db:"user_agent" json:"user_agent,omitempty"`
	Details   sql.NullString `db:"details" json:"details,omitempty"`
	CreatedAt time.Time      `db:"created_at" json:"created_at"`
}

// AdminLogResponse 日志响应模型
type AdminLogResponse struct {
	ID        int64      `json:"id"`
	UserID    int64      `json:"user_id"`
	Username  string     `json:"username"`
	Action    string     `json:"action"`
	Target    string     `json:"target,omitempty"`
	IP        string     `json:"ip,omitempty"`
	UserAgent string     `json:"user_agent,omitempty"`
	Details   string     `json:"details,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

// ToResponse 转换为响应模型
func (l *AdminLog) ToResponse() *AdminLogResponse {
	resp := &AdminLogResponse{
		ID:        l.ID,
		UserID:    l.UserID,
		Username:  l.Username,
		Action:    string(l.Action),
		CreatedAt: l.CreatedAt,
	}
	if l.Target.Valid {
		resp.Target = l.Target.String
	}
	if l.IP.Valid {
		resp.IP = l.IP.String
	}
	if l.UserAgent.Valid {
		resp.UserAgent = l.UserAgent.String
	}
	if l.Details.Valid {
		resp.Details = l.Details.String
	}
	return resp
}

// ============================================
// 文件相关模型
// ============================================

// FileStatus 文件状态
type FileStatus string

const (
	FileStatusNormal  FileStatus = "normal"
	FileStatusDeleted FileStatus = "deleted"
)

// File 文件模型
type File struct {
	ID              int64          `db:"id" json:"id"`
	RandomPath      string         `db:"random_path" json:"random_path"`
	FileID          string         `db:"file_id" json:"file_id"`
	FileUniqueID    string         `db:"file_unique_id" json:"file_unique_id"`
	MimeType        string         `db:"mime_type" json:"mime_type"`
	FileSize        int            `db:"file_size" json:"file_size"`
	FileName        sql.NullString `db:"file_name" json:"file_name,omitempty"`
	UploadIP        []byte         `db:"upload_ip" json:"upload_ip"`
	EdgeIP          []byte         `db:"edge_ip" json:"edge_ip"`
	Status          FileStatus     `db:"status" json:"status"`
	DeleteReason    sql.NullString `db:"delete_reason" json:"delete_reason,omitempty"`
	CreatedAt       time.Time      `db:"created_at" json:"created_at"`
	LastAccessedAt  sql.NullTime   `db:"last_accessed_at" json:"last_accessed_at,omitempty"`
	CacheExpiresAt  time.Time      `db:"cache_expires_at" json:"cache_expires_at"`
}

// FileResponse 文件响应模型
type FileResponse struct {
	ID             int64   `json:"id"`
	RandomPath     string  `json:"random_path"`
	FileID         string  `json:"file_id"`
	FileUniqueID   string  `json:"file_unique_id"`
	MimeType       string  `json:"mime_type"`
	FileSize       int     `json:"file_size"`
	FileName       string  `json:"file_name,omitempty"`
	UploadIP       string  `json:"upload_ip"`
	EdgeIP         string  `json:"edge_ip"`
	Status         string  `json:"status"`
	DeleteReason   string  `json:"delete_reason,omitempty"`
	CreatedAt      string  `json:"created_at"`
	LastAccessedAt string  `json:"last_accessed_at,omitempty"`
}

// ToResponse 转换为响应模型
func (f *File) ToResponse() *FileResponse {
	resp := &FileResponse{
		ID:            f.ID,
		RandomPath:    f.RandomPath,
		FileID:        f.FileID,
		FileUniqueID:  f.FileUniqueID,
		MimeType:      f.MimeType,
		FileSize:      f.FileSize,
		UploadIP:      ipToString(f.UploadIP),
		EdgeIP:        ipToString(f.EdgeIP),
		Status:        string(f.Status),
		CreatedAt:     f.CreatedAt.Format("2006-01-02 15:04:05"),
	}
	if f.FileName.Valid {
		resp.FileName = f.FileName.String
	}
	if f.DeleteReason.Valid {
		resp.DeleteReason = f.DeleteReason.String
	}
	if f.LastAccessedAt.Valid {
		resp.LastAccessedAt = f.LastAccessedAt.Time.Format("2006-01-02 15:04:05")
	}
	return resp
}

// ============================================
// IP封禁相关模型
// ============================================

// BannedIP 封禁IP模型
type BannedIP struct {
	IP       []byte    `db:"ip" json:"ip"`
	BannedAt time.Time `db:"banned_at" json:"banned_at"`
	Reason   string    `db:"reason" json:"reason,omitempty"`
}

// BannedIPResponse 封禁IP响应模型
type BannedIPResponse struct {
	IP       string    `json:"ip"`
	BannedAt time.Time `json:"banned_at"`
	Reason   string    `json:"reason,omitempty"`
}

// ============================================
// 统计相关模型
// ============================================

// Stats 统计数据模型
type Stats struct {
	TotalFiles   int     `json:"total_files"`
	TodayUploads int     `json:"today_uploads"`
	TodayAccess  int     `json:"today_access"`
	CachedFiles  int     `json:"cached_files"`
	BannedIPs    int     `json:"banned_ips"`
	CacheHitRate float64 `json:"cache_hit_rate"`
}

// ============================================
// 辅助函数
// ============================================

// ipToString 将字节数组IP转换为字符串
func ipToString(ip []byte) string {
	if len(ip) == 0 {
		return ""
	}
	// IPv6
	if len(ip) == 16 {
		return string(ip)
	}
	// IPv4
	if len(ip) == 4 {
		return formatIPv4(ip)
	}
	return ""
}

// formatIPv4 格式化IPv4地址
func formatIPv4(ip []byte) string {
	return fmt.Sprintf("%d.%d.%d.%d", ip[0], ip[1], ip[2], ip[3])
}

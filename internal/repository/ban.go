package repository

import (
	"context"
	"database/sql"
	"net"

	"github.com/tg-imagebed-refactored/internal/model"
)

// BanRepository IP封禁仓库接口
type BanRepository interface {
	IsBanned(ctx context.Context, ip net.IP) (bool, string, error)
	Ban(ctx context.Context, ip net.IP, reason string) error
	Unban(ctx context.Context, ip net.IP) error
	List(ctx context.Context, offset, limit int) ([]*model.BannedIP, error)
	Count(ctx context.Context) (int64, error)
}

// banRepository IP封禁仓库实现
type banRepository struct {
	db *sql.DB
}

// NewBanRepository 创建IP封禁仓库
func NewBanRepository(db *sql.DB) BanRepository {
	return &banRepository{db: db}
}

// IsBanned 检查IP是否被封禁
func (r *banRepository) IsBanned(ctx context.Context, ip net.IP) (bool, string, error) {
	query := `SELECT reason FROM banned_ips WHERE ip = ?`
	var reason sql.NullString
	err := r.db.QueryRowContext(ctx, query, ipToBytes(ip)).Scan(&reason)
	if err == sql.ErrNoRows {
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	if !reason.Valid || reason.String == "" {
		return true, "IP已被封禁", nil
	}
	return true, reason.String, nil
}

// Ban 封禁IP
func (r *banRepository) Ban(ctx context.Context, ip net.IP, reason string) error {
	query := `INSERT INTO banned_ips (ip, banned_at, reason) VALUES (?, NOW(), ?)`
	_, err := r.db.ExecContext(ctx, query, ipToBytes(ip), reason)
	return err
}

// Unban 解封IP
func (r *banRepository) Unban(ctx context.Context, ip net.IP) error {
	query := `DELETE FROM banned_ips WHERE ip = ?`
	_, err := r.db.ExecContext(ctx, query, ipToBytes(ip))
	return err
}

// List 获取封禁列表
func (r *banRepository) List(ctx context.Context, offset, limit int) ([]*model.BannedIP, error) {
	query := `
		SELECT ip, banned_at, reason 
		FROM banned_ips 
		ORDER BY banned_at DESC 
		LIMIT ? OFFSET ?
	`
	rows, err := r.db.QueryContext(ctx, query, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bans []*model.BannedIP
	for rows.Next() {
		ban := &model.BannedIP{}
		err := rows.Scan(&ban.IP, &ban.BannedAt, &ban.Reason)
		if err != nil {
			return nil, err
		}
		bans = append(bans, ban)
	}
	return bans, nil
}

// Count 获取封禁总数
func (r *banRepository) Count(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM banned_ips`).Scan(&count)
	return count, err
}

// ipToBytes 将IP转换为字节数组
func ipToBytes(ip net.IP) []byte {
	if ip == nil {
		return nil
	}
	return ip.To16()
}

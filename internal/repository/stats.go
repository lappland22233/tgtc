package repository

import (
	"context"
	"database/sql"
	"time"
)

// StatsRepository 统计仓库接口
type StatsRepository interface {
	GetTotalFiles(ctx context.Context) (int64, error)
	GetTodayUploads(ctx context.Context) (int64, error)
	GetCachedFiles(ctx context.Context) (int64, error)
	GetBannedIPs(ctx context.Context) (int64, error)
}

// statsRepository 统计仓库实现
type statsRepository struct {
	db *sql.DB
}

// NewStatsRepository 创建统计仓库
func NewStatsRepository(db *sql.DB) StatsRepository {
	return &statsRepository{db: db}
}

// GetTotalFiles 获取文件总数
func (r *statsRepository) GetTotalFiles(ctx context.Context) (int64, error) {
	var count int64
	// 假设有 files 表
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM files WHERE status = 'normal'`).Scan(&count)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	return count, nil
}

// GetTodayUploads 获取今日上传数
func (r *statsRepository) GetTodayUploads(ctx context.Context) (int64, error) {
	var count int64
	today := time.Now().Format("2006-01-02")
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM files WHERE DATE(created_at) = ?`, today).Scan(&count)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	return count, nil
}

// GetCachedFiles 获取缓存文件数
func (r *statsRepository) GetCachedFiles(ctx context.Context) (int64, error) {
	var count int64
	// 缓存文件是未过期的文件
	now := time.Now()
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM files WHERE status = 'normal' AND cache_expires_at > ?`, now).Scan(&count)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	return count, nil
}

// GetBannedIPs 获取封禁IP数
func (r *statsRepository) GetBannedIPs(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM banned_ips`).Scan(&count)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	return count, nil
}

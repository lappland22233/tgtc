package repository

import (
	"context"
	"database/sql"

	"github.com/tg-imagebed-refactored/internal/model"
)

// AdminLogRepository 操作日志仓库接口
type AdminLogRepository interface {
	Create(ctx context.Context, log *model.AdminLog) error
	List(ctx context.Context, offset, limit int, userID *int64, action *string) ([]*model.AdminLog, error)
	Count(ctx context.Context, userID *int64, action *string) (int64, error)
}

// adminLogRepository 操作日志仓库实现
type adminLogRepository struct {
	db *sql.DB
}

// NewAdminLogRepository 创建操作日志仓库
func NewAdminLogRepository(db *sql.DB) AdminLogRepository {
	return &adminLogRepository{db: db}
}

// Create 创建日志
func (r *adminLogRepository) Create(ctx context.Context, log *model.AdminLog) error {
	query := `
		INSERT INTO admin_logs (user_id, username, action, target, ip, user_agent, details, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
	`
	result, err := r.db.ExecContext(ctx, query,
		log.UserID, log.Username, log.Action, log.Target, log.IP, log.UserAgent, log.Details,
	)
	if err != nil {
		return err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return err
	}
	log.ID = id
	return nil
}

// List 获取日志列表
func (r *adminLogRepository) List(ctx context.Context, offset, limit int, userID *int64, action *string) ([]*model.AdminLog, error) {
	query := `
		SELECT id, user_id, username, action, target, ip, user_agent, details, created_at
		FROM admin_logs
		WHERE 1=1
	`
	args := []interface{}{}

	if userID != nil {
		query += " AND user_id = ?"
		args = append(args, *userID)
	}
	if action != nil && *action != "" {
		query += " AND action = ?"
		args = append(args, *action)
	}

	query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
	args = append(args, limit, offset)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []*model.AdminLog
	for rows.Next() {
		log := &model.AdminLog{}
		err := rows.Scan(
			&log.ID, &log.UserID, &log.Username, &log.Action, &log.Target,
			&log.IP, &log.UserAgent, &log.Details, &log.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		logs = append(logs, log)
	}
	return logs, nil
}

// Count 获取日志总数
func (r *adminLogRepository) Count(ctx context.Context, userID *int64, action *string) (int64, error) {
	query := `SELECT COUNT(*) FROM admin_logs WHERE 1=1`
	args := []interface{}{}

	if userID != nil {
		query += " AND user_id = ?"
		args = append(args, *userID)
	}
	if action != nil && *action != "" {
		query += " AND action = ?"
		args = append(args, *action)
	}

	var count int64
	err := r.db.QueryRowContext(ctx, query, args...).Scan(&count)
	return count, err
}

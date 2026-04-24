package repository

import (
	"context"
	"database/sql"
	"time"

	"github.com/tg-imagebed-refactored/internal/model"
)

// UserRepository 用户仓库接口
type UserRepository interface {
	Create(ctx context.Context, user *model.User) error
	GetByID(ctx context.Context, id int64) (*model.User, error)
	GetByUsername(ctx context.Context, username string) (*model.User, error)
	Update(ctx context.Context, user *model.User) error
	Delete(ctx context.Context, id int64) error
	List(ctx context.Context, offset, limit int) ([]*model.User, error)
	Count(ctx context.Context) (int64, error)
	UpdateLastLogin(ctx context.Context, id int64, ip string) error
}

// userRepository 用户仓库实现
type userRepository struct {
	db *sql.DB
}

// NewUserRepository 创建用户仓库
func NewUserRepository(db *sql.DB) UserRepository {
	return &userRepository{db: db}
}

// Create 创建用户
func (r *userRepository) Create(ctx context.Context, user *model.User) error {
	query := `
		INSERT INTO users (username, password_hash, role, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, NOW(), NOW())
	`
	result, err := r.db.ExecContext(ctx, query, user.Username, user.PasswordHash, user.Role, user.Status)
	if err != nil {
		return err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return err
	}
	user.ID = id
	return nil
}

// GetByID 根据ID获取用户
func (r *userRepository) GetByID(ctx context.Context, id int64) (*model.User, error) {
	query := `
		SELECT id, username, password_hash, role, status, last_login_at, last_login_ip, login_count, created_at, updated_at
		FROM users WHERE id = ?
	`
	user := &model.User{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Username, &user.PasswordHash, &user.Role, &user.Status,
		&user.LastLoginAt, &user.LastLoginIP, &user.LoginCount, &user.CreatedAt, &user.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return user, nil
}

// GetByUsername 根据用户名获取用户
func (r *userRepository) GetByUsername(ctx context.Context, username string) (*model.User, error) {
	query := `
		SELECT id, username, password_hash, role, status, last_login_at, last_login_ip, login_count, created_at, updated_at
		FROM users WHERE username = ?
	`
	user := &model.User{}
	err := r.db.QueryRowContext(ctx, query, username).Scan(
		&user.ID, &user.Username, &user.PasswordHash, &user.Role, &user.Status,
		&user.LastLoginAt, &user.LastLoginIP, &user.LoginCount, &user.CreatedAt, &user.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return user, nil
}

// Update 更新用户
func (r *userRepository) Update(ctx context.Context, user *model.User) error {
	query := `
		UPDATE users 
		SET username = ?, role = ?, status = ?, updated_at = NOW()
		WHERE id = ?
	`
	_, err := r.db.ExecContext(ctx, query, user.Username, user.Role, user.Status, user.ID)
	return err
}

// Delete 删除用户
func (r *userRepository) Delete(ctx context.Context, id int64) error {
	query := `DELETE FROM users WHERE id = ?`
	_, err := r.db.ExecContext(ctx, query, id)
	return err
}

// List 获取用户列表（分页）
func (r *userRepository) List(ctx context.Context, offset, limit int) ([]*model.User, error) {
	query := `
		SELECT id, username, password_hash, role, status, last_login_at, last_login_ip, login_count, created_at, updated_at
		FROM users 
		ORDER BY created_at DESC 
		LIMIT ? OFFSET ?
	`
	rows, err := r.db.QueryContext(ctx, query, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*model.User
	for rows.Next() {
		user := &model.User{}
		err := rows.Scan(
			&user.ID, &user.Username, &user.PasswordHash, &user.Role, &user.Status,
			&user.LastLoginAt, &user.LastLoginIP, &user.LoginCount, &user.CreatedAt, &user.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, nil
}

// Count 获取用户总数
func (r *userRepository) Count(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

// UpdateLastLogin 更新最后登录信息
func (r *userRepository) UpdateLastLogin(ctx context.Context, id int64, ip string) error {
	query := `
		UPDATE users 
		SET last_login_at = ?, last_login_ip = ?, login_count = login_count + 1
		WHERE id = ?
	`
	_, err := r.db.ExecContext(ctx, query, time.Now(), ip, id)
	return err
}

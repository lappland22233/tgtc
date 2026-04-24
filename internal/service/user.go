package service

import (
	"context"
	"errors"

	"github.com/tg-imagebed-refactored/internal/model"
	"github.com/tg-imagebed-refactored/internal/repository"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrUsernameExists    = errors.New("用户名已存在")
	ErrCannotDeleteSelf  = errors.New("不能删除自己")
	ErrInvalidRole       = errors.New("无效的角色")
	ErrCannotModifySuper = errors.New("不能修改超级管理员")
)

// UserService 用户管理服务接口
type UserService interface {
	CreateUser(ctx context.Context, req *CreateUserRequest) (*model.User, error)
	UpdateUser(ctx context.Context, req *UpdateUserRequest) (*model.User, error)
	DeleteUser(ctx context.Context, operatorID, targetID int64) error
	GetUser(ctx context.Context, id int64) (*model.User, error)
	ListUsers(ctx context.Context, page, pageSize int) ([]*model.User, int64, error)
	ChangePassword(ctx context.Context, userID int64, oldPassword, newPassword string) error
	ResetPassword(ctx context.Context, operatorID, targetID int64, newPassword string) error
}

// CreateUserRequest 创建用户请求
type CreateUserRequest struct {
	Username string          `json:"username" binding:"required,min=3,max=50"`
	Password string          `json:"password" binding:"required,min=6,max=100"`
	Role     model.UserRole  `json:"role" binding:"required"`
}

// UpdateUserRequest 更新用户请求
type UpdateUserRequest struct {
	ID       int64           `json:"id"`
	Username string          `json:"username" binding:"required,min=3,max=50"`
	Role     model.UserRole  `json:"role"`
	Status   model.UserStatus `json:"status"`
}

// userService 用户管理服务实现
type userService struct {
	userRepo repository.UserRepository
	logRepo  repository.AdminLogRepository
}

// NewUserService 创建用户管理服务
func NewUserService(userRepo repository.UserRepository, logRepo repository.AdminLogRepository) UserService {
	return &userService{
		userRepo: userRepo,
		logRepo:  logRepo,
	}
}

// CreateUser 创建用户
func (s *userService) CreateUser(ctx context.Context, req *CreateUserRequest) (*model.User, error) {
	// 检查用户名是否存在
	existing, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, ErrUsernameExists
	}

	// 验证角色
	if !isValidRole(req.Role) {
		return nil, ErrInvalidRole
	}

	// 加密密码
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	user := &model.User{
		Username:     req.Username,
		PasswordHash: string(hashedPassword),
		Role:         req.Role,
		Status:       model.UserStatusActive,
	}

	if err := s.userRepo.Create(ctx, user); err != nil {
		return nil, err
	}

	// 获取完整用户信息
	return s.userRepo.GetByID(ctx, user.ID)
}

// UpdateUser 更新用户
func (s *userService) UpdateUser(ctx context.Context, req *UpdateUserRequest) (*model.User, error) {
	// 获取现有用户
	user, err := s.userRepo.GetByID(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrUserNotFound
	}

	// 不能修改超级管理员的角色（除非是超级管理员操作）
	if user.Role == model.RoleSuperAdmin && req.Role != model.RoleSuperAdmin {
		return nil, ErrCannotModifySuper
	}

	// 验证角色
	if !isValidRole(req.Role) {
		return nil, ErrInvalidRole
	}

	user.Username = req.Username
	user.Role = req.Role
	user.Status = req.Status

	if err := s.userRepo.Update(ctx, user); err != nil {
		return nil, err
	}

	return user, nil
}

// DeleteUser 删除用户
func (s *userService) DeleteUser(ctx context.Context, operatorID, targetID int64) error {
	if operatorID == targetID {
		return ErrCannotDeleteSelf
	}

	// 获取目标用户
	target, err := s.userRepo.GetByID(ctx, targetID)
	if err != nil {
		return err
	}
	if target == nil {
		return ErrUserNotFound
	}

	// 不能删除超级管理员
	if target.Role == model.RoleSuperAdmin {
		return ErrCannotModifySuper
	}

	// 获取操作者信息用于日志
	operator, _ := s.userRepo.GetByID(ctx, operatorID)

	// 删除用户
	if err := s.userRepo.Delete(ctx, targetID); err != nil {
		return err
	}

	// 记录日志
	username := "unknown"
	if operator != nil {
		username = operator.Username
	}
	s.logRepo.Create(ctx, &model.AdminLog{
		UserID:   operatorID,
		Username: username,
		Action:   model.ActionDeleteUser,
		Target:   &target.Username,
	})

	return nil
}

// GetUser 获取用户
func (s *userService) GetUser(ctx context.Context, id int64) (*model.User, error) {
	return s.userRepo.GetByID(ctx, id)
}

// ListUsers 获取用户列表
func (s *userService) ListUsers(ctx context.Context, page, pageSize int) ([]*model.User, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}

	offset := (page - 1) * pageSize
	users, err := s.userRepo.List(ctx, offset, pageSize)
	if err != nil {
		return nil, 0, err
	}

	total, err := s.userRepo.Count(ctx)
	if err != nil {
		return nil, 0, err
	}

	return users, total, nil
}

// ChangePassword 修改密码（用户自己）
func (s *userService) ChangePassword(ctx context.Context, userID int64, oldPassword, newPassword string) error {
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}

	// 验证旧密码
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(oldPassword)); err != nil {
		return ErrInvalidCredentials
	}

	// 加密新密码
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	user.PasswordHash = string(hashedPassword)
	if err := s.userRepo.Update(ctx, user); err != nil {
		return err
	}

	// 记录日志
	s.logRepo.Create(ctx, &model.AdminLog{
		UserID:   userID,
		Username: user.Username,
		Action:   model.ActionChangePassword,
	})

	return nil
}

// ResetPassword 重置密码（管理员操作）
func (s *userService) ResetPassword(ctx context.Context, operatorID, targetID int64, newPassword string) error {
	target, err := s.userRepo.GetByID(ctx, targetID)
	if err != nil {
		return err
	}
	if target == nil {
		return ErrUserNotFound
	}

	// 加密新密码
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	target.PasswordHash = string(hashedPassword)
	if err := s.userRepo.Update(ctx, target); err != nil {
		return err
	}

	// 获取操作者信息
	operator, _ := s.userRepo.GetByID(ctx, operatorID)
	operatorUsername := "unknown"
	if operator != nil {
		operatorUsername = operator.Username
	}

	// 记录日志
	s.logRepo.Create(ctx, &model.AdminLog{
		UserID:   operatorID,
		Username: operatorUsername,
		Action:   model.ActionChangePassword,
		Target:   &target.Username,
	})

	return nil
}

// isValidRole 验证角色是否有效
func isValidRole(role model.UserRole) bool {
	switch role {
	case model.RoleSuperAdmin, model.RoleAdmin, model.RoleOperator:
		return true
	default:
		return false
	}
}

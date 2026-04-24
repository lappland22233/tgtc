package service

import (
	"context"
	"errors"
	"net"
	"strings"

	"github.com/tg-imagebed-refactored/internal/model"
	"github.com/tg-imagebed-refactored/internal/repository"
)

var (
	ErrInvalidIP = errors.New("无效的IP地址")
)

// AdminService 管理功能服务（日志与封禁）
type AdminService interface {
	ListLogs(ctx context.Context, page, pageSize int, userID *int64, action *string) ([]*model.AdminLog, int64, error)
	ListBans(ctx context.Context, page, pageSize int) ([]*model.BannedIP, int64, error)
	BanIP(ctx context.Context, ip, reason string) error
	UnbanIP(ctx context.Context, ip string) error
}

type adminService struct {
	logRepo repository.AdminLogRepository
	banRepo repository.BanRepository
}

// NewAdminService 创建管理功能服务
func NewAdminService(logRepo repository.AdminLogRepository, banRepo repository.BanRepository) AdminService {
	return &adminService{logRepo: logRepo, banRepo: banRepo}
}

func (s *adminService) ListLogs(ctx context.Context, page, pageSize int, userID *int64, action *string) ([]*model.AdminLog, int64, error) {
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
	logs, err := s.logRepo.List(ctx, offset, pageSize, userID, action)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.logRepo.Count(ctx, userID, action)
	if err != nil {
		return nil, 0, err
	}
	return logs, total, nil
}

func (s *adminService) ListBans(ctx context.Context, page, pageSize int) ([]*model.BannedIP, int64, error) {
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
	bans, err := s.banRepo.List(ctx, offset, pageSize)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.banRepo.Count(ctx)
	if err != nil {
		return nil, 0, err
	}
	return bans, total, nil
}

func (s *adminService) BanIP(ctx context.Context, ip, reason string) error {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil {
		return ErrInvalidIP
	}
	return s.banRepo.Ban(ctx, parsed, strings.TrimSpace(reason))
}

func (s *adminService) UnbanIP(ctx context.Context, ip string) error {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil {
		return ErrInvalidIP
	}
	return s.banRepo.Unban(ctx, parsed)
}

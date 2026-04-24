package service

import (
	"context"

	"github.com/tg-imagebed-refactored/internal/model"
	"github.com/tg-imagebed-refactored/internal/repository"
)

// StatsService 统计服务接口
type StatsService interface {
	GetStats(ctx context.Context) (*model.Stats, error)
}

// statsService 统计服务实现
type statsService struct {
	statsRepo repository.StatsRepository
}

// NewStatsService 创建统计服务
func NewStatsService(statsRepo repository.StatsRepository) StatsService {
	return &statsService{statsRepo: statsRepo}
}

// GetStats 获取统计数据
func (s *statsService) GetStats(ctx context.Context) (*model.Stats, error) {
	totalFiles, err := s.statsRepo.GetTotalFiles(ctx)
	if err != nil {
		totalFiles = 0
	}

	todayUploads, err := s.statsRepo.GetTodayUploads(ctx)
	if err != nil {
		todayUploads = 0
	}

	cachedFiles, err := s.statsRepo.GetCachedFiles(ctx)
	if err != nil {
		cachedFiles = 0
	}

	bannedIPs, err := s.statsRepo.GetBannedIPs(ctx)
	if err != nil {
		bannedIPs = 0
	}

	// 计算缓存命中率（缓存文件数/总文件数）
	var cacheHitRate float64
	if totalFiles > 0 {
		cacheHitRate = float64(cachedFiles) / float64(totalFiles) * 100
	}

	return &model.Stats{
		TotalFiles:   int(totalFiles),
		TodayUploads: int(todayUploads),
		TodayAccess:  0, // 访问统计需要单独的表或计数器
		CachedFiles:  int(cachedFiles),
		BannedIPs:    int(bannedIPs),
		CacheHitRate: cacheHitRate,
	}, nil
}

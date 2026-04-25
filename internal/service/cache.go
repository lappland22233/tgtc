package service

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/tg-imagebed-refactored/internal/config"
)

// CacheStats 缓存统计
type CacheStats struct {
	Dir          string `json:"dir"`
	TotalFiles   int    `json:"total_files"`
	ExpiredFiles int    `json:"expired_files"`
	TotalSize    int64  `json:"total_size"`
	TTLMinutes   int    `json:"ttl_minutes"`
}

// CacheCleanResult 缓存清理结果
type CacheCleanResult struct {
	RemovedFiles int   `json:"removed_files"`
	FreedBytes   int64 `json:"freed_bytes"`
	CleanAll     bool  `json:"clean_all"`
}

// CacheService 缓存服务接口
type CacheService interface {
	GetStats(ctx context.Context) (*CacheStats, error)
	Clean(ctx context.Context, cleanAll bool) (*CacheCleanResult, error)
}

type cacheService struct {
	cfg config.CacheConfig
}

// NewCacheService 创建缓存服务
func NewCacheService(cfg config.CacheConfig) CacheService {
	return &cacheService{cfg: cfg}
}

func (s *cacheService) GetStats(_ context.Context) (*CacheStats, error) {
	if err := os.MkdirAll(s.cfg.Dir, 0o755); err != nil {
		return nil, err
	}

	var stats CacheStats
	stats.Dir = s.cfg.Dir
	stats.TTLMinutes = s.cfg.TTLMinutes

	now := time.Now()
	ttl := s.cfg.GetTTL()

	err := filepath.WalkDir(s.cfg.Dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		stats.TotalFiles++
		stats.TotalSize += info.Size()
		if ttl > 0 && info.ModTime().Add(ttl).Before(now) {
			stats.ExpiredFiles++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &stats, nil
}

func (s *cacheService) Clean(_ context.Context, cleanAll bool) (*CacheCleanResult, error) {
	if err := os.MkdirAll(s.cfg.Dir, 0o755); err != nil {
		return nil, err
	}

	now := time.Now()
	ttl := s.cfg.GetTTL()
	result := &CacheCleanResult{CleanAll: cleanAll}

	err := filepath.WalkDir(s.cfg.Dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		remove := cleanAll
		if !remove {
			remove = ttl > 0 && info.ModTime().Add(ttl).Before(now)
		}

		if !remove {
			return nil
		}

		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}

		result.RemovedFiles++
		result.FreedBytes += info.Size()
		return nil
	})
	if err != nil {
		return nil, err
	}

	return result, nil
}

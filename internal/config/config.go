package config

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Config 应用配置
type Config struct {
	Server   ServerConfig   `json:"server"`
	Telegram TelegramConfig `json:"telegram"`
	Database DatabaseConfig `json:"database"`
	JWT      JWTConfig      `json:"jwt"`
	Cache    CacheConfig    `json:"cache"`
	Upload   UploadConfig   `json:"upload"`
	Log      LogConfig      `json:"log"`
}

// ServerConfig 服务器配置
type ServerConfig struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Mode string `json:"mode"`
}

// TelegramConfig Telegram配置
type TelegramConfig struct {
	BotToken   string `json:"bot_token"`
	ChannelID  string `json:"channel_id"`
}

// DatabaseConfig 数据库配置
type DatabaseConfig struct {
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Username        string `json:"username"`
	Password        string `json:"password"`
	Database        string `json:"database"`
	MaxOpenConns    int    `json:"max_open_conns"`
	MaxIdleConns    int    `json:"max_idle_conns"`
	ConnMaxLifetime int    `json:"conn_max_lifetime"` // 秒
}

// JWTConfig JWT配置
type JWTConfig struct {
	Secret             string `json:"secret"`
	ExpiryHours        int    `json:"expiry_hours"`
	RefreshExpiryHours  int    `json:"refresh_expiry_hours"`
}

// CacheConfig 缓存配置
type CacheConfig struct {
	Dir                   string `json:"dir"`
	TTLMinutes            int    `json:"ttl_minutes"`
	CleanIntervalMinutes  int    `json:"clean_interval_minutes"`
}

// UploadConfig 上传配置
type UploadConfig struct {
	MaxSizeMB     int      `json:"max_size_mb"`
	AllowedTypes  []string `json:"allowed_types"`
}

// LogConfig 日志配置
type LogConfig struct {
	Level  string `json:"level"`
	Format string `json:"format"`
	Output string `json:"output"`
}

// GetAddr 获取服务器地址
func (c *ServerConfig) GetAddr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// GetDSN 获取数据库连接字符串
func (c *DatabaseConfig) GetDSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=true&loc=Local",
		c.Username, c.Password, c.Host, c.Port, c.Database)
}

// GetConnMaxLifetime 获取连接最大生命周期
func (c *DatabaseConfig) GetConnMaxLifetime() time.Duration {
	return time.Duration(c.ConnMaxLifetime) * time.Second
}

// GetTTL 获取缓存TTL
func (c *CacheConfig) GetTTL() time.Duration {
	return time.Duration(c.TTLMinutes) * time.Minute
}

// GetExpiry 获取JWT过期时间
func (c *JWTConfig) GetExpiry() time.Duration {
	return time.Duration(c.ExpiryHours) * time.Hour
}

// GetRefreshExpiry 获取JWT刷新过期时间
func (c *JWTConfig) GetRefreshExpiry() time.Duration {
	return time.Duration(c.RefreshExpiryHours) * time.Hour
}

// Load 加载配置文件
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}

	// 设置默认值
	cfg.setDefaults()

	return &cfg, nil
}

// setDefaults 设置默认配置值
func (c *Config) setDefaults() {
	if c.Server.Host == "" {
		c.Server.Host = "0.0.0.0"
	}
	if c.Server.Port == 0 {
		c.Server.Port = 8080
	}
	if c.Server.Mode == "" {
		c.Server.Mode = "debug"
	}
	if c.Database.MaxOpenConns == 0 {
		c.Database.MaxOpenConns = 50
	}
	if c.Database.MaxIdleConns == 0 {
		c.Database.MaxIdleConns = 10
	}
	if c.Database.ConnMaxLifetime == 0 {
		c.Database.ConnMaxLifetime = 3600
	}
	if c.JWT.ExpiryHours == 0 {
		c.JWT.ExpiryHours = 24
	}
	if c.JWT.RefreshExpiryHours == 0 {
		c.JWT.RefreshExpiryHours = 168
	}
	if c.Cache.Dir == "" {
		c.Cache.Dir = "/data/cache"
	}
	if c.Cache.TTLMinutes == 0 {
		c.Cache.TTLMinutes = 10
	}
	if c.Cache.CleanIntervalMinutes == 0 {
		c.Cache.CleanIntervalMinutes = 5
	}
	if c.Upload.MaxSizeMB == 0 {
		c.Upload.MaxSizeMB = 20
	}
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
	if c.Log.Format == "" {
		c.Log.Format = "json"
	}
}

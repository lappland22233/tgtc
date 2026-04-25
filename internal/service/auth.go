package service

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/tg-imagebed-refactored/internal/config"
	"github.com/tg-imagebed-refactored/internal/model"
	"github.com/tg-imagebed-refactored/internal/repository"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidCredentials = errors.New("用户名或密码错误")
	ErrUserDisabled       = errors.New("账号已被禁用")
	ErrUserNotFound       = errors.New("用户不存在")
)

// AuthService 认证服务接口
type AuthService interface {
	Login(ctx context.Context, username, password, ip string) (*AuthResult, error)
	ValidateToken(ctx context.Context, tokenString string) (*Claims, error)
	RefreshToken(ctx context.Context, refreshToken string) (*AuthResult, error)
	GetCurrentUser(ctx context.Context, userID int64) (*model.User, error)
}

// AuthResult 认证结果
type AuthResult struct {
	AccessToken  string      `json:"access_token"`
	RefreshToken string      `json:"refresh_token"`
	ExpiresAt    time.Time   `json:"expires_at"`
	User         *model.User `json:"user"`
}

// Claims JWT Claims
type Claims struct {
	UserID   int64          `json:"user_id"`
	Username string         `json:"username"`
	Role     model.UserRole `json:"role"`
	jwt.RegisteredClaims
}

// authService 认证服务实现
type authService struct {
	userRepo repository.UserRepository
	logRepo  repository.AdminLogRepository
	cfg      *config.JWTConfig
}

// NewAuthService 创建认证服务
func NewAuthService(userRepo repository.UserRepository, logRepo repository.AdminLogRepository, cfg *config.JWTConfig) AuthService {
	return &authService{
		userRepo: userRepo,
		logRepo:  logRepo,
		cfg:      cfg,
	}
}

// Login 用户登录
func (s *authService) Login(ctx context.Context, username, password, ip string) (*AuthResult, error) {
	// 获取用户
	user, err := s.userRepo.GetByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrInvalidCredentials
	}

	// 检查账号状态
	if user.Status != model.UserStatusActive {
		return nil, ErrUserDisabled
	}

	// 验证密码
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, ErrInvalidCredentials
	}

	// 生成Token
	accessToken, expiresAt, err := s.generateToken(user)
	if err != nil {
		return nil, err
	}

	refreshToken, err := s.generateRefreshToken(user)
	if err != nil {
		return nil, err
	}

	// 更新最后登录信息
	if err := s.userRepo.UpdateLastLogin(ctx, user.ID, ip); err != nil {
		// 日志记录失败不影响登录
	}

	// 记录操作日志
	s.logRepo.Create(ctx, &model.AdminLog{
		UserID:   user.ID,
		Username: user.Username,
		Action:   model.ActionLogin,
		IP:       sql.NullString{String: ip, Valid: ip != ""},
	})

	return &AuthResult{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresAt:    expiresAt,
		User:         user,
	}, nil
}

// ValidateToken 验证Token
func (s *authService) ValidateToken(ctx context.Context, tokenString string) (*Claims, error) {
	claims, err := s.parseToken(tokenString)
	if err != nil {
		return nil, err
	}

	// 验证用户仍然存在且状态正常
	user, err := s.userRepo.GetByID(ctx, claims.UserID)
	if err != nil {
		return nil, err
	}
	if user == nil || user.Status != model.UserStatusActive {
		return nil, ErrUserDisabled
	}

	return claims, nil
}

// RefreshToken 刷新Token
func (s *authService) RefreshToken(ctx context.Context, refreshToken string) (*AuthResult, error) {
	claims, err := s.parseRefreshToken(refreshToken)
	if err != nil {
		return nil, err
	}

	// 获取用户
	user, err := s.userRepo.GetByID(ctx, claims.UserID)
	if err != nil {
		return nil, err
	}
	if user == nil || user.Status != model.UserStatusActive {
		return nil, ErrUserDisabled
	}

	// 生成新Token
	accessToken, expiresAt, err := s.generateToken(user)
	if err != nil {
		return nil, err
	}

	newRefreshToken, err := s.generateRefreshToken(user)
	if err != nil {
		return nil, err
	}

	return &AuthResult{
		AccessToken:  accessToken,
		RefreshToken: newRefreshToken,
		ExpiresAt:    expiresAt,
		User:         user,
	}, nil
}

// GetCurrentUser 获取当前用户
func (s *authService) GetCurrentUser(ctx context.Context, userID int64) (*model.User, error) {
	return s.userRepo.GetByID(ctx, userID)
}

// generateToken 生成访问令牌
func (s *authService) generateToken(user *model.User) (string, time.Time, error) {
	expiresAt := time.Now().Add(s.cfg.GetExpiry())

	claims := &Claims{
		UserID:   user.ID,
		Username: user.Username,
		Role:     user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Issuer:    "tg-imagebed",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString([]byte(s.cfg.Secret))
	if err != nil {
		return "", time.Time{}, err
	}

	return tokenString, expiresAt, nil
}

// generateRefreshToken 生成刷新令牌
func (s *authService) generateRefreshToken(user *model.User) (string, error) {
	expiresAt := time.Now().Add(s.cfg.GetRefreshExpiry())

	// 使用用户ID和时间的hash作为刷新令牌的标识
	hash := sha256.New()
	hash.Write([]byte(user.Username))
	hash.Write([]byte(time.Now().String()))
	refreshID := hex.EncodeToString(hash.Sum(nil))

	claims := &Claims{
		UserID:   user.ID,
		Username: refreshID,
		Role:     user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Issuer:    "tg-imagebed-refresh",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(s.cfg.Secret))
}

// parseToken 解析访问令牌
func (s *authService) parseToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("不支持的签名算法")
		}
		return []byte(s.cfg.Secret), nil
	})
	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		if claims.Issuer != "tg-imagebed" {
			return nil, errors.New("无效的token")
		}
		return claims, nil
	}

	return nil, errors.New("无效的token")
}

// parseRefreshToken 解析刷新令牌
func (s *authService) parseRefreshToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("不支持的签名算法")
		}
		return []byte(s.cfg.Secret), nil
	})
	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		if claims.Issuer != "tg-imagebed-refresh" {
			return nil, errors.New("无效的refresh token")
		}
		return claims, nil
	}

	return nil, errors.New("无效的refresh token")
}

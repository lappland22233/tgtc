package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/tg-imagebed-refactored/internal/service"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// contextKey Context键类型
type contextKey string

const (
	// ClaimsKey 用户信息键
	ClaimsKey contextKey = "claims"
)

// AuthMiddleware 认证中间件
type AuthMiddleware struct {
	authService service.AuthService
}

// NewAuthMiddleware 创建认证中间件
func NewAuthMiddleware(authService service.AuthService) *AuthMiddleware {
	return &AuthMiddleware{authService: authService}
}

// Authenticate 认证中间件处理器
func (m *AuthMiddleware) Authenticate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 从 Authorization 头获取 token
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			response.Unauthorized(w, "未登录，请先登录")
			return
		}

		// 解析 Bearer token
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		if tokenString == authHeader {
			response.Unauthorized(w, "无效的认证格式")
			return
		}

		// 验证token
		claims, err := m.authService.ValidateToken(r.Context(), tokenString)
		if err != nil {
			response.Unauthorized(w, "登录已过期，请重新登录")
			return
		}

		// 将用户信息放入context
		ctx := WithClaims(r.Context(), claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

// OptionalAuth 可选认证中间件（不强制要求登录）
func (m *AuthMiddleware) OptionalAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			next.ServeHTTP(w, r)
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		if tokenString == authHeader {
			next.ServeHTTP(w, r)
			return
		}

		claims, err := m.authService.ValidateToken(r.Context(), tokenString)
		if err == nil {
			ctx := WithClaims(r.Context(), claims)
			r = r.WithContext(ctx)
		}

		next.ServeHTTP(w, r)
	}
}

// WithClaims 将用户信息放入context
func WithClaims(ctx context.Context, claims *service.Claims) context.Context {
	return context.WithValue(ctx, ClaimsKey, claims)
}

// GetClaimsFromContext 从context获取用户信息
func GetClaimsFromContext(ctx context.Context) (*service.Claims, bool) {
	claims, ok := ctx.Value(ClaimsKey).(*service.Claims)
	return claims, ok
}

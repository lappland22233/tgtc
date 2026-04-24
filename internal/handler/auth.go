package handler

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/tg-imagebed-refactored/internal/middleware"
	"github.com/tg-imagebed-refactored/internal/service"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// AuthHandler 认证处理器
type AuthHandler struct {
	authService service.AuthService
}

// NewAuthHandler 创建认证处理器
func NewAuthHandler(authService service.AuthService) *AuthHandler {
	return &AuthHandler{authService: authService}
}

// LoginRequest 登录请求
type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

// Login 登录接口
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.BadRequest(w, "method not allowed")
		return
	}

	var req LoginRequest
	if err := decodeJSON(r, &req); err != nil {
		response.BadRequest(w, "invalid request format")
		return
	}

	// 获取客户端IP
	clientIP := getClientIP(r)

	// 执行登录
	result, err := h.authService.Login(r.Context(), req.Username, req.Password, clientIP)
	if err != nil {
		switch err {
		case service.ErrInvalidCredentials:
			response.Error(w, http.StatusUnauthorized, "用户名或密码错误")
		case service.ErrUserDisabled:
			response.Error(w, http.StatusForbidden, "账号已被禁用")
		default:
			response.InternalError(w, "登录失败")
		}
		return
	}

	response.SuccessWithMessage(w, "登录成功", map[string]interface{}{
		"access_token":  result.AccessToken,
		"refresh_token": result.RefreshToken,
		"expires_at":    result.ExpiresAt,
		"user":          result.User.ToResponse(),
	})
}

// RefreshTokenRequest 刷新令牌请求
type RefreshTokenRequest struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

// RefreshToken 刷新令牌接口
func (h *AuthHandler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.BadRequest(w, "method not allowed")
		return
	}

	var req RefreshTokenRequest
	if err := decodeJSON(r, &req); err != nil {
		response.BadRequest(w, "invalid request format")
		return
	}

	result, err := h.authService.RefreshToken(r.Context(), req.RefreshToken)
	if err != nil {
		response.Unauthorized(w, "令牌已过期，请重新登录")
		return
	}

	response.Success(w, map[string]interface{}{
		"access_token":  result.AccessToken,
		"refresh_token": result.RefreshToken,
		"expires_at":    result.ExpiresAt,
	})
}

// GetMe 获取当前用户信息
func (h *AuthHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	claims, ok := middleware.GetClaimsFromContext(r.Context())
	if !ok || claims == nil {
		response.Unauthorized(w, "未登录")
		return
	}

	user, err := h.authService.GetCurrentUser(r.Context(), claims.UserID)
	if err != nil || user == nil {
		response.Unauthorized(w, "用户不存在")
		return
	}

	response.Success(w, user.ToResponse())
}

// Logout 登出接口
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	// JWT无状态，客户端删除token即可
	// 这里可以记录登出日志（如果有Session则删除Session）
	response.SuccessMessage(w, "登出成功")
}

// Helper function to decode JSON
func decodeJSON(r *http.Request, v interface{}) error {
	return json.NewDecoder(r.Body).Decode(v)
}

// Helper function to get client IP
func getClientIP(r *http.Request) string {
	// 优先读取 X-Forwarded-For
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		return strings.TrimSpace(ips[0])
	}
	// 回退到 RemoteAddr
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

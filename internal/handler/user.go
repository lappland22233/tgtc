package handler

import (
	"net/http"
	"strconv"

	"github.com/tg-imagebed-refactored/internal/middleware"
	"github.com/tg-imagebed-refactored/internal/model"
	"github.com/tg-imagebed-refactored/internal/service"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// UserHandler 用户管理处理器
type UserHandler struct {
	userService service.UserService
}

// NewUserHandler 创建用户管理处理器
func NewUserHandler(userService service.UserService) *UserHandler {
	return &UserHandler{userService: userService}
}

// ListUsers 获取用户列表
func (h *UserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))

	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}

	users, total, err := h.userService.ListUsers(r.Context(), page, pageSize)
	if err != nil {
		response.InternalError(w, "获取用户列表失败")
		return
	}

	// 转换为响应格式
	userResponses := make([]*model.UserResponse, len(users))
	for i, user := range users {
		userResponses[i] = user.ToResponse()
	}

	response.Paginated(w, userResponses, total, page, pageSize)
}

// CreateUser 创建用户
func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.BadRequest(w, "method not allowed")
		return
	}

	claims, ok := middleware.GetClaimsFromContext(r.Context())
	if !ok || claims == nil || !canManageUsers(claims) {
		response.Forbidden(w, "权限不足")
		return
	}

	var req service.CreateUserRequest
	if err := decodeJSON(r, &req); err != nil {
		response.BadRequest(w, "无效的请求格式")
		return
	}

	user, err := h.userService.CreateUser(r.Context(), &req)
	if err != nil {
		switch err {
		case service.ErrUsernameExists:
			response.Error(w, http.StatusConflict, "用户名已存在")
		case service.ErrInvalidRole:
			response.BadRequest(w, "无效的角色")
		default:
			response.InternalError(w, "创建用户失败")
		}
		return
	}

	response.SuccessWithMessage(w, "用户创建成功", user.ToResponse())
}

// UpdateUser 更新用户
func (h *UserHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		response.BadRequest(w, "method not allowed")
		return
	}

	claims, ok := middleware.GetClaimsFromContext(r.Context())
	if !ok || claims == nil || !canManageUsers(claims) {
		response.Forbidden(w, "权限不足")
		return
	}

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		response.BadRequest(w, "无效的用户ID")
		return
	}

	var req service.UpdateUserRequest
	if err := decodeJSON(r, &req); err != nil {
		response.BadRequest(w, "无效的请求格式")
		return
	}
	req.ID = id

	user, err := h.userService.UpdateUser(r.Context(), &req)
	if err != nil {
		switch err {
		case service.ErrUserNotFound:
			response.NotFound(w, "用户不存在")
		case service.ErrCannotModifySuper:
			response.Forbidden(w, "不能修改超级管理员")
		default:
			response.InternalError(w, "更新用户失败")
		}
		return
	}

	response.SuccessWithMessage(w, "用户更新成功", user.ToResponse())
}

// DeleteUser 删除用户
func (h *UserHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		response.BadRequest(w, "method not allowed")
		return
	}

	claims, ok := middleware.GetClaimsFromContext(r.Context())
	if !ok || claims == nil || !canManageUsers(claims) {
		response.Forbidden(w, "权限不足")
		return
	}

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		response.BadRequest(w, "无效的用户ID")
		return
	}

	if err := h.userService.DeleteUser(r.Context(), claims.UserID, id); err != nil {
		switch err {
		case service.ErrCannotDeleteSelf:
			response.BadRequest(w, "不能删除自己")
		case service.ErrCannotModifySuper:
			response.Forbidden(w, "不能删除超级管理员")
		default:
			response.InternalError(w, "删除用户失败")
		}
		return
	}

	response.SuccessMessage(w, "用户删除成功")
}

// GetUser 获取单个用户
func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	claims, ok := middleware.GetClaimsFromContext(r.Context())
	if !ok || claims == nil {
		response.Unauthorized(w, "未登录")
		return
	}

	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		response.BadRequest(w, "无效的用户ID")
		return
	}

	// 只有超级管理员可以查看其他用户，普通用户只能查看自己
	if id != claims.UserID && !canManageUsers(claims) {
		response.Forbidden(w, "权限不足")
		return
	}

	user, err := h.userService.GetUser(r.Context(), id)
	if err != nil || user == nil {
		response.NotFound(w, "用户不存在")
		return
	}

	response.Success(w, user.ToResponse())
}

// ChangePasswordRequest 修改密码请求
type ChangePasswordRequest struct {
	OldPassword string `json:"old_password" binding:"required"`
	NewPassword string `json:"new_password" binding:"required,min=6"`
}

// ChangePassword 修改密码
func (h *UserHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.BadRequest(w, "method not allowed")
		return
	}

	claims, ok := middleware.GetClaimsFromContext(r.Context())
	if !ok || claims == nil {
		response.Unauthorized(w, "未登录")
		return
	}

	var req ChangePasswordRequest
	if err := decodeJSON(r, &req); err != nil {
		response.BadRequest(w, "无效的请求格式")
		return
	}

	if err := h.userService.ChangePassword(r.Context(), claims.UserID, req.OldPassword, req.NewPassword); err != nil {
		if err == service.ErrInvalidCredentials {
			response.Error(w, http.StatusUnauthorized, "原密码错误")
		} else {
			response.InternalError(w, "修改密码失败")
		}
		return
	}

	response.SuccessMessage(w, "密码修改成功")
}

// Helper function to check if user can manage other users
func canManageUsers(claims *service.Claims) bool {
	return claims.Role == model.RoleSuperAdmin
}

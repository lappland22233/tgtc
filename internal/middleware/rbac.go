package middleware

import (
	"net/http"

	"github.com/tg-imagebed-refactored/internal/model"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// RequireRole 角色权限中间件
func RequireRole(roles ...model.UserRole) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			claims, ok := GetClaimsFromContext(r.Context())
			if !ok {
				response.Unauthorized(w, "未登录")
				return
			}

			// 检查用户角色是否在允许的角色列表中
			for _, role := range roles {
				if claims.Role == role {
					next.ServeHTTP(w, r)
					return
				}
			}

			response.Forbidden(w, "权限不足")
		}
	}
}

// RequireSuperAdmin 需要超级管理员权限
func RequireSuperAdmin(next http.HandlerFunc) http.HandlerFunc {
	return RequireRole(model.RoleSuperAdmin)(next)
}

// RequireAdmin 需要管理员或超级管理员权限
func RequireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return RequireRole(model.RoleSuperAdmin, model.RoleAdmin)(next)
}

// RequireOperator 需要操作员或更高权限
func RequireOperator(next http.HandlerFunc) http.HandlerFunc {
	return RequireRole(model.RoleSuperAdmin, model.RoleAdmin, model.RoleOperator)(next)
}

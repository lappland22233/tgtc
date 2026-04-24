package handler

import (
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/tg-imagebed-refactored/internal/model"
	"github.com/tg-imagebed-refactored/internal/service"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// AdminHandler 管理功能处理器（日志与封禁）
type AdminHandler struct {
	adminService service.AdminService
}

// NewAdminHandler 创建管理功能处理器
func NewAdminHandler(adminService service.AdminService) *AdminHandler {
	return &AdminHandler{adminService: adminService}
}

// ListLogs 获取操作日志
func (h *AdminHandler) ListLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		response.BadRequest(w, "method not allowed")
		return
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))

	var userID *int64
	if q := strings.TrimSpace(r.URL.Query().Get("user_id")); q != "" {
		parsed, err := strconv.ParseInt(q, 10, 64)
		if err != nil {
			response.BadRequest(w, "无效的user_id")
			return
		}
		userID = &parsed
	}

	var action *string
	if q := strings.TrimSpace(r.URL.Query().Get("action")); q != "" {
		action = &q
	}

	logs, total, err := h.adminService.ListLogs(r.Context(), page, pageSize, userID, action)
	if err != nil {
		response.InternalError(w, "获取日志失败")
		return
	}

	items := make([]*model.AdminLogResponse, len(logs))
	for i, l := range logs {
		items[i] = l.ToResponse()
	}

	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	response.Paginated(w, items, total, page, pageSize)
}

// ListBans 获取封禁列表
func (h *AdminHandler) ListBans(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		response.BadRequest(w, "method not allowed")
		return
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))

	bans, total, err := h.adminService.ListBans(r.Context(), page, pageSize)
	if err != nil {
		response.InternalError(w, "获取封禁列表失败")
		return
	}

	items := make([]*model.BannedIPResponse, len(bans))
	for i, ban := range bans {
		items[i] = &model.BannedIPResponse{
			IP:       net.IP(ban.IP).String(),
			BannedAt: ban.BannedAt,
			Reason:   ban.Reason,
		}
	}

	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	response.Paginated(w, items, total, page, pageSize)
}

type banRequest struct {
	IP     string `json:"ip"`
	Reason string `json:"reason"`
}

// BanIP 封禁IP
func (h *AdminHandler) BanIP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.BadRequest(w, "method not allowed")
		return
	}

	var req banRequest
	if err := decodeJSON(r, &req); err != nil {
		response.BadRequest(w, "无效的请求格式")
		return
	}

	if err := h.adminService.BanIP(r.Context(), req.IP, req.Reason); err != nil {
		if err == service.ErrInvalidIP {
			response.BadRequest(w, "无效的IP地址")
			return
		}
		response.InternalError(w, "封禁IP失败")
		return
	}

	response.SuccessMessage(w, "IP封禁成功")
}

// UnbanIP 解封IP
func (h *AdminHandler) UnbanIP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		response.BadRequest(w, "method not allowed")
		return
	}

	ip := strings.TrimSpace(r.URL.Query().Get("ip"))
	if ip == "" {
		response.BadRequest(w, "缺少ip参数")
		return
	}

	if err := h.adminService.UnbanIP(r.Context(), ip); err != nil {
		if err == service.ErrInvalidIP {
			response.BadRequest(w, "无效的IP地址")
			return
		}
		response.InternalError(w, "解封IP失败")
		return
	}

	response.SuccessMessage(w, "IP解封成功")
}

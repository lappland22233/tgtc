package handler

import (
	"net/http"

	"github.com/tg-imagebed-refactored/internal/service"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// CacheHandler 缓存管理处理器
type CacheHandler struct {
	cacheService service.CacheService
}

// NewCacheHandler 创建缓存处理器
func NewCacheHandler(cacheService service.CacheService) *CacheHandler {
	return &CacheHandler{cacheService: cacheService}
}

// GetStats 获取缓存统计
func (h *CacheHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		response.BadRequest(w, "method not allowed")
		return
	}

	stats, err := h.cacheService.GetStats(r.Context())
	if err != nil {
		response.InternalError(w, "获取缓存统计失败")
		return
	}

	response.Success(w, stats)
}

// Clean 清理缓存
func (h *CacheHandler) Clean(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.BadRequest(w, "method not allowed")
		return
	}

	type cleanRequest struct {
		All bool `json:"all"`
	}

	var req cleanRequest
	if err := decodeJSON(r, &req); err != nil && r.ContentLength > 0 {
		response.BadRequest(w, "无效的请求格式")
		return
	}

	result, err := h.cacheService.Clean(r.Context(), req.All)
	if err != nil {
		response.InternalError(w, "清理缓存失败")
		return
	}

	response.SuccessWithMessage(w, "缓存清理完成", result)
}

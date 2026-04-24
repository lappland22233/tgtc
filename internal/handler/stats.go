package handler

import (
	"net/http"

	"github.com/tg-imagebed-refactored/internal/service"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// StatsHandler 统计处理器
type StatsHandler struct {
	statsService service.StatsService
}

// NewStatsHandler 创建统计处理器
func NewStatsHandler(statsService service.StatsService) *StatsHandler {
	return &StatsHandler{statsService: statsService}
}

// GetStats 获取统计数据
func (h *StatsHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		response.BadRequest(w, "method not allowed")
		return
	}

	stats, err := h.statsService.GetStats(r.Context())
	if err != nil {
		response.InternalError(w, "获取统计数据失败")
		return
	}

	response.Success(w, stats)
}

package handler

import (
	"net/http"
	"time"

	"github.com/tg-imagebed-refactored/pkg/response"
)

// Health 服务健康检查
func Health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		response.BadRequest(w, "method not allowed")
		return
	}

	response.Success(w, map[string]interface{}{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
	})
}

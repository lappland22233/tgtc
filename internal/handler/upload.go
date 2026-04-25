package handler

import (
	"errors"
	"net/http"

	"github.com/tg-imagebed-refactored/internal/service"
	"github.com/tg-imagebed-refactored/pkg/response"
)

// UploadHandler 文件上传处理器
type UploadHandler struct {
	uploadService service.UploadService
	maxSizeBytes  int64
}

// NewUploadHandler 创建文件上传处理器
func NewUploadHandler(uploadService service.UploadService, maxSizeMB int) *UploadHandler {
	if maxSizeMB <= 0 {
		maxSizeMB = 20
	}
	return &UploadHandler{
		uploadService: uploadService,
		maxSizeBytes:  int64(maxSizeMB) * 1024 * 1024,
	}
}

// Upload 上传文件（multipart/form-data, file字段）
func (h *UploadHandler) Upload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		response.BadRequest(w, "method not allowed")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, h.maxSizeBytes+1024)
	if err := r.ParseMultipartForm(h.maxSizeBytes); err != nil {
		response.BadRequest(w, "文件过大或表单格式错误")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		response.BadRequest(w, "缺少file文件字段")
		return
	}
	defer file.Close()

	result, err := h.uploadService.Save(r.Context(), file, header)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrUploadTooLarge):
			response.BadRequest(w, "文件大小超过限制")
		case errors.Is(err, service.ErrUploadTypeNotAllowed):
			response.BadRequest(w, "文件类型不允许")
		default:
			response.InternalError(w, "文件上传失败")
		}
		return
	}

	response.SuccessWithMessage(w, "文件上传成功", result)
}

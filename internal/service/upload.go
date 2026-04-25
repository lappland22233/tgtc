package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tg-imagebed-refactored/internal/config"
)

var (
	ErrUploadTooLarge       = errors.New("upload file too large")
	ErrUploadTypeNotAllowed = errors.New("upload type not allowed")
)

// UploadResult 上传结果
type UploadResult struct {
	Filename   string `json:"filename"`
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	MimeType   string `json:"mime_type"`
	UploadedAt string `json:"uploaded_at"`
}

// UploadService 上传服务接口
type UploadService interface {
	Save(ctx context.Context, file multipart.File, header *multipart.FileHeader) (*UploadResult, error)
}

type uploadService struct {
	cfg config.UploadConfig
	dir string
}

// NewUploadService 创建上传服务
func NewUploadService(cfg config.UploadConfig, cacheDir string) UploadService {
	uploadDir := deriveUploadDir(cacheDir)
	return &uploadService{
		cfg: cfg,
		dir: uploadDir,
	}
}

func deriveUploadDir(cacheDir string) string {
	cleanCacheDir := filepath.Clean(cacheDir)
	cacheParentDir := filepath.Dir(cleanCacheDir)
	cacheBaseName := filepath.Base(cleanCacheDir)

	if cacheBaseName == "." || cacheBaseName == string(filepath.Separator) {
		cacheBaseName = "cache"
	}

	return filepath.Join(cacheParentDir, cacheBaseName+"_uploads")
}

func (s *uploadService) Save(_ context.Context, file multipart.File, header *multipart.FileHeader) (*UploadResult, error) {
	maxSize := int64(s.cfg.MaxSizeMB) * 1024 * 1024
	if maxSize > 0 && header.Size > maxSize {
		return nil, ErrUploadTooLarge
	}

	headerBytes := make([]byte, 512)
	n, err := file.Read(headerBytes)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}

	contentType := http.DetectContentType(headerBytes[:n])
	if !isAllowedType(contentType, s.cfg.AllowedTypes) {
		return nil, ErrUploadTypeNotAllowed
	}

	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return nil, err
	}

	ext := strings.ToLower(filepath.Ext(header.Filename))
	name, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	storedName := fmt.Sprintf("%s%s", name, ext)
	storedPath := filepath.Join(s.dir, storedName)

	dst, err := os.Create(storedPath)
	if err != nil {
		return nil, err
	}
	defer dst.Close()

	size, err := io.Copy(dst, io.LimitReader(file, maxSize+1))
	if err != nil {
		return nil, err
	}
	if maxSize > 0 && size > maxSize {
		_ = os.Remove(storedPath)
		return nil, ErrUploadTooLarge
	}

	return &UploadResult{
		Filename:   header.Filename,
		Path:       storedPath,
		Size:       size,
		MimeType:   contentType,
		UploadedAt: time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func isAllowedType(contentType string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, t := range allowed {
		t = strings.TrimSpace(strings.ToLower(t))
		if t == "" {
			continue
		}
		if t == strings.ToLower(contentType) {
			return true
		}
		if strings.HasSuffix(t, "/*") {
			prefix := strings.TrimSuffix(t, "*")
			if strings.HasPrefix(strings.ToLower(contentType), prefix) {
				return true
			}
		}
	}
	return false
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

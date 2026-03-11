package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	_ "github.com/go-sql-driver/mysql"
)

// ================= 配置区 =================

var (
	ConfigFile = "data.json"
	ListenAddr = ":8080"
	CacheDir   = "/data/cache"
	CacheTTL   = 10 * time.Minute
	MaxUpload  = int64(20 << 20) // 20MB
	TGAPI      = "https://api.telegram.org"
)

// 配置结构体
type Config struct {
	Telegram struct {
		BotToken  string `json:"bot_token"`
		ChannelID string `json:"channel_id"` // 群组 ID 或频道 ID，群组为负数，如 -1001234567890
	} `json:"telegram"`
	MySQL struct {
		Host     string `json:"host"`
		Port     int    `json:"port"`
		Username string `json:"username"`
		Password string `json:"password"`
		Database string `json:"database"`
	} `json:"mysql"`
	Admin struct {
		UserIDs []int64 `json:"user_ids"`
	} `json:"admin"`
	APIKeys []string `json:"api_keys"` // API Key 列表，用于管理后台认证
}

var (
	config      *Config
	db          *sql.DB
	jwtSecret   []byte // JWT 签名密钥（从配置文件加载或生成后保存）
	tokenExpiry = 2 * time.Hour       // Token 有效期 2 小时
)

// ======================================================

func main() {
	loadConfig()
	if err := initDB(); err != nil {
		log.Fatalf("数据库初始化失败: %v", err)
	}

	log.Printf("[认证] JWT Token 认证已启用（有效期：%v）", tokenExpiry)
	log.Printf("[安全提示] 请在 data.json 中配置 api_keys，使用强随机密钥")

	if err := os.MkdirAll(CacheDir, 0755); err != nil {
		log.Fatalf("创建缓存目录失败: %v", err)
	}

	// 启动缓存清理协程
	go cacheCleaner()

	// 初始化随机数生成器
	rand.Seed(time.Now().UnixNano())

	// 初始化或加载 JWT 密钥
	initJWTSecret()

	mux := http.NewServeMux()
	mux.HandleFunc("/upload", uploadHandler)
	mux.HandleFunc("/", fetchHandler)

	// 管理后台 API 路由
	// /admin.html 不需要认证（登录页面）
	mux.HandleFunc("/admin.html", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "admin/index.html")
	})
	// 其他管理 API 需要 JWT 认证
	mux.HandleFunc("/api/stats", jwtAuthMiddleware(statsHandler))
	mux.HandleFunc("/api/files", jwtAuthMiddleware(filesHandler))
	mux.HandleFunc("/api/banned", jwtAuthMiddleware(bannedListHandler))
	mux.HandleFunc("/api/ban", jwtAuthMiddleware(banHandler))
	mux.HandleFunc("/api/unban", jwtAuthMiddleware(unbanHandler))
	mux.HandleFunc("/api/delete", jwtAuthMiddleware(deleteHandler))
	
	// 认证相关 API
	mux.HandleFunc("/api/login", loginHandler)
	mux.HandleFunc("/api/verify", verifyHandler)

	srv := &http.Server{
		Addr:         ListenAddr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("服务启动监听: %s", ListenAddr)
	log.Printf("缓存目录: %s", CacheDir)
	log.Printf("最大上传: %d MB", MaxUpload>>20)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// ================= JWT 认证相关 =================

// Claims JWT Claims 结构体
type Claims struct {
	APIKeyHash string `json:"api_key_hash"`
	jwt.RegisteredClaims
}

// generateJWTSecret 生成 JWT 签名密钥（基于时间戳和随机数）
func generateJWTSecret() []byte {
	// 生产环境建议使用环境变量或配置文件
	secret := fmt.Sprintf("tg-upload-secret-%d-%d", time.Now().UnixNano(), rand.Int63())
	hasher := sha256.New()
	hasher.Write([]byte(secret))
	return hasher.Sum(nil)
}

// initJWTSecret 初始化 JWT 密钥（从配置文件加载或生成后保存）
func initJWTSecret() {
	jwtSecretFile := "jwt_secret.key"
	
	// 尝试读取已存在的密钥文件
	if data, err := os.ReadFile(jwtSecretFile); err == nil {
		jwtSecret = data
		log.Printf("[认证] 已加载 JWT 密钥文件：%s", jwtSecretFile)
		return
	}
	
	// 生成新密钥并保存到文件
	jwtSecret = generateJWTSecret()
	if err := os.WriteFile(jwtSecretFile, jwtSecret, 0600); err != nil {
		log.Printf("[警告] 保存 JWT 密钥文件失败：%v，重启后 Token 将失效", err)
	} else {
		log.Printf("[认证] 已生成并保存 JWT 密钥文件：%s", jwtSecretFile)
	}
}

// hashAPIKey 对 API Key 进行 SHA-256 哈希
func hashAPIKey(key string) string {
	hasher := sha256.New()
	hasher.Write([]byte(key))
	return hex.EncodeToString(hasher.Sum(nil))
}

// validateAPIKey 验证 API Key 是否有效
func validateAPIKey(apiKey string) bool {
	if apiKey == "" {
		return false
	}
	hashedKey := hashAPIKey(apiKey)
	for _, configuredKey := range config.APIKeys {
		if hashAPIKey(configuredKey) == hashedKey {
			return true
		}
	}
	return false
}

// generateToken 生成 JWT token
func generateToken(apiKey string) (string, error) {
	if !validateAPIKey(apiKey) {
		return "", errors.New("无效的 API Key")
	}

	claims := &Claims{
		APIKeyHash: hashAPIKey(apiKey),
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(tokenExpiry)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(jwtSecret)
	if err != nil {
		return "", fmt.Errorf("生成 token 失败：%w", err)
	}

	return tokenString, nil
}

// validateToken 验证 JWT token
func validateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("不支持的签名算法：%v", token.Header["alg"])
		}
		return jwtSecret, nil
	})

	if err != nil {
		return nil, fmt.Errorf("解析 token 失败：%w", err)
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		// 验证 API Key Hash 是否匹配
		if !validateAPIKeyHash(claims.APIKeyHash) {
			return nil, errors.New("API Key 已失效")
		}
		return claims, nil
	}

	return nil, errors.New("无效的 token")
}

// validateAPIKeyHash 验证 API Key Hash 是否仍然有效
func validateAPIKeyHash(hashedKey string) bool {
	for _, configuredKey := range config.APIKeys {
		if hashAPIKey(configuredKey) == hashedKey {
			return true
		}
	}
	return false
}

// ================= HTTP Handlers =================

// 启用 CORS
func enableCORS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

// 上传处理器
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	enableCORS(w, r)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clientIP := getClientIP(r)
	edgeIP := getEdgeIP(r)

	log.Printf("[上传] 客户端IP: %s, 边缘IP: %s", clientIP, edgeIP)

	// 检查IP封禁
	banReason := isBanned(clientIP)
	if banReason != "" {
		log.Printf("[上传] IP已封禁: %s, 原因: %s", clientIP, banReason)

		// 🔥 关键：丢弃请求体，避免客户端一直发
		io.Copy(io.Discard, r.Body)
		r.Body.Close()

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(fmt.Sprintf(
			`{"error":"forbidden","reason":"%s","ip":"%s"}`,
			banReason,
			clientIP.String(),
		)))
		return
	}

	// 限制请求体大小
	r.Body = http.MaxBytesReader(w, r.Body, MaxUpload)
	file, hdr, err := r.FormFile("file")
	if err != nil {
		log.Printf("[上传] 获取文件失败: %v", err)
		http.Error(w, "invalid upload", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 检查文件大小
	if hdr.Size > MaxUpload {
		log.Printf("[上传] 文件过大: %d 字节", hdr.Size)
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}

	// 读取文件数据
	data, err := io.ReadAll(file)
	if err != nil {
		log.Printf("[上传] 读取文件失败: %v", err)
		http.Error(w, "read error", http.StatusInternalServerError)
		return
	}

	// 确定MIME类型
	mimeType := hdr.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(hdr.Filename))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	// 上传到Telegram (传递原始文件名)
	filename := hdr.Filename
	fileID, fileUID, err := tgUpload(data, mimeType, filename)
	if err != nil {
		log.Printf("[上传] Telegram上传失败: %v", err)
		http.Error(w, "telegram upload failed", http.StatusBadGateway)
		return
	}

	log.Printf("[上传] Telegram返回 file_id=%s, file_uid=%s", fileID, fileUID)

	// 生成随机路径
	path := randPath(24)

	// 写入数据库
	result, err := db.Exec(`
		INSERT INTO files
		(random_path, file_id, file_unique_id, mime_type, file_size, file_name,
		 upload_ip, edge_ip, status, created_at, last_accessed_at, cache_expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'normal', NOW(), NOW(), NOW() + INTERVAL 10 MINUTE)`,
		path, fileID, fileUID, mimeType, len(data), filename, ipToBin(clientIP), ipToBin(edgeIP))
	if err != nil {
		log.Printf("[上传] 数据库写入失败: %v", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	id, _ := result.LastInsertId()
	log.Printf("[上传] 数据库插入成功: id=%d, path=%s, file_id=%s, size=%d, mime=%s, filename=%s", id, path, fileID, len(data), mimeType, filename)

	// 获取访问域名
	scheme := "https"
	if r.Header.Get("X-Forwarded-Proto") == "http" {
		scheme = "http"
	}
	host := r.Host
	if host == "" {
		host = "tcapi.krsi.top"
	}

	// 返回完整访问URL
	accessURL := fmt.Sprintf("%s://%s/%s", scheme, host, path)

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "%s", accessURL)
}

// 获取文件处理器
func fetchHandler(w http.ResponseWriter, r *http.Request) {
	enableCORS(w, r)

	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		http.NotFound(w, r)
		return
	}

	// 记录访问
	clientIP := getClientIP(r)
	log.Printf("[访问] 路径: %s, IP: %s", path, clientIP)

	// 检查IP封禁
	banReason := isBanned(clientIP)
	if banReason != "" {
		log.Printf("[访问] IP已封禁: %s, 原因: %s", clientIP, banReason)

		// 🔥 关键：丢弃请求体，避免客户端一直发
		io.Copy(io.Discard, r.Body)
		r.Body.Close()

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(fmt.Sprintf(
			`{"error":"forbidden","reason":"%s","ip":"%s"}`,
			banReason,
			clientIP.String(),
		)))
		return
	}

	// 开始事务（使用行锁防止缓存击穿）
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		log.Printf("[访问] 事务开始失败: %v", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	var fileID, mimeType, fileName, status string
	var deleteReason sql.NullString
	var expire time.Time

	// 查询文件信息（FOR UPDATE 行锁）
	err = tx.QueryRow(`
		SELECT file_id, mime_type, file_name, cache_expires_at, status, delete_reason
		FROM files
		WHERE random_path = ?
		FOR UPDATE`, path).
		Scan(&fileID, &mimeType, &fileName, &expire, &status, &deleteReason)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			log.Printf("[访问] 文件不存在: %s", path)
			tx.Rollback()
			http.NotFound(w, r)
			return
		}
		log.Printf("[访问] 查询失败: %v", err)
		tx.Rollback()
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	if status == "deleted" {
		_ = tx.Rollback()
		reason := "文件已被管理员删除"
		if deleteReason.Valid && strings.TrimSpace(deleteReason.String) != "" {
			reason = deleteReason.String
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusGone)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":  "deleted",
			"reason": reason,
		})
		return
	}

	cachePath := filepath.Join(CacheDir, path)

	// 检查缓存是否存在和有效
	if time.Now().After(expire) || !fileExists(cachePath) {
		log.Printf("[访问] 缓存过期或不存在，从Telegram拉取: %s, file_id: %s", path, fileID)

		if err := tgDownload(fileID, cachePath); err != nil {
			log.Printf("[访问] Telegram下载失败: %v", err)
			tx.Rollback()
			http.Error(w, "telegram fetch failed", http.StatusBadGateway)
			return
		}
	}

	// 更新访问时间和缓存过期时间
	_, err = tx.Exec(`
		UPDATE files
		SET last_accessed_at = NOW(),
		    cache_expires_at = NOW() + INTERVAL 10 MINUTE
		WHERE random_path = ?`, path)
	if err != nil {
		log.Printf("[访问] 更新访问时间失败: %v", err)
		tx.Rollback()
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(); err != nil {
		log.Printf("[访问] 事务提交失败: %v", err)
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	// 返回文件 (支持在线预览)
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Cache-Control", "public, max-age=600")

	// 使用原始文件名
	dispFilename := fileName
	if dispFilename == "" {
		dispFilename = filepath.Base(cachePath)
	}

	// 图片文件添加 Content-Disposition inline (在线预览)
	if strings.HasPrefix(mimeType, "image/") || strings.HasPrefix(mimeType, "video/") {
		w.Header().Set("Content-Disposition", "inline; filename=\""+dispFilename+"\"")
	} else {
		w.Header().Set("Content-Disposition", "attachment; filename=\""+dispFilename+"\"")
	}

	http.ServeFile(w, r, cachePath)

	log.Printf("[访问] 成功: %s, 缓存: %s, 文件名: %s", path, cachePath, dispFilename)
}

// ================= 管理后台 =================

type statsResponse struct {
	TotalFiles   int     `json:"total_files"`
	TodayUploads int     `json:"today_uploads"`
	TodayAccess  int     `json:"today_access"`
	CachedFiles  int     `json:"cached_files"`
	BannedIPs    int     `json:"banned_ips"`
	CacheHitRate float64 `json:"cache_hit_rate"`
}

type fileRecord struct {
	ID             int    `json:"id"`
	RandomPath     string `json:"random_path"`
	FileID         string `json:"file_id"`
	FileUniqueID   string `json:"file_unique_id"`
	MimeType       string `json:"mime_type"`
	FileSize       int    `json:"file_size"`
	FileName       string `json:"file_name"`
	UploadIP       string `json:"upload_ip"`
	EdgeIP         string `json:"edge_ip"`
	Status         string `json:"status"`
	DeleteReason   string `json:"delete_reason"`
	CreatedAt      string `json:"created_at"`
	LastAccessedAt string `json:"last_accessed_at"`
}

type filesResponse struct {
	Files       []fileRecord `json:"files"`
	CurrentPage int          `json:"current_page"`
	TotalPages  int          `json:"total_pages"`
	TotalCount  int          `json:"total_count"`
}

type bannedIPRecord struct {
	IP       string `json:"ip"`
	BannedAt string `json:"banned_at"`
	Reason   string `json:"reason"`
}

type apiResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type banRequest struct {
	IP     string `json:"ip"`
	Reason string `json:"reason"`
}

type deleteRequest struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type loginRequest struct {
	APIKey string `json:"api_key"`
}

type loginResponse struct {
	Success bool   `json:"success"`
	Token   string `json:"token"`
	Message string `json:"message"`
}

type verifyResponse struct {
	Valid   bool   `json:"valid"`
	Message string `json:"message"`
}

// 登录接口：验证 API Key 并返回 JWT token
func loginHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(loginResponse{Success: false, Message: "method not allowed"})
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(loginResponse{Success: false, Message: "无效的请求格式"})
		return
	}

	if req.APIKey == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(loginResponse{Success: false, Message: "API Key 不能为空"})
		return
	}

	// 验证 API Key 并生成 token
	token, err := generateToken(req.APIKey)
	if err != nil {
		log.Printf("[认证] 登录失败：%v", err)
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(loginResponse{Success: false, Message: "API Key 无效"})
		return
	}

	log.Printf("[认证] 登录成功")
	_ = json.NewEncoder(w).Encode(loginResponse{Success: true, Token: token, Message: "登录成功"})
}

// 验证接口：检查 token 是否有效
func verifyHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(verifyResponse{Valid: false, Message: "method not allowed"})
		return
	}

	// 从 Authorization 头获取 token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(verifyResponse{Valid: false, Message: "未提供 token"})
		return
	}

	tokenString := strings.TrimPrefix(authHeader, "Bearer ")
	if tokenString == authHeader {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(verifyResponse{Valid: false, Message: "无效的 token 格式"})
		return
	}

	_, err := validateToken(tokenString)
	if err != nil {
		log.Printf("[认证] 验证失败：%v", err)
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(verifyResponse{Valid: false, Message: err.Error()})
		return
	}

	_ = json.NewEncoder(w).Encode(verifyResponse{Valid: true, Message: "token 有效"})
}

// JWT 认证中间件
func jwtAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 从 Authorization 头获取 token
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="TG图床后台管理"`)
			http.Error(w, "需要认证", http.StatusUnauthorized)
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		if tokenString == authHeader {
			w.Header().Set("WWW-Authenticate", `Bearer realm="TG图床后台管理"`)
			http.Error(w, "无效的 token 格式", http.StatusUnauthorized)
			return
		}

		claims, err := validateToken(tokenString)
		if err != nil {
			log.Printf("[认证] Token 验证失败：%v, from %s", err, r.RemoteAddr)
			w.Header().Set("WWW-Authenticate", `Bearer realm="TG图床后台管理"`)
			http.Error(w, "认证失败："+err.Error(), http.StatusUnauthorized)
			return
		}

		log.Printf("[认证] Token 验证通过：%s", claims.APIKeyHash[:16]+"...")
		next(w, r)
	}
}



func statsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	stats := statsResponse{}
	_ = db.QueryRow(`SELECT COUNT(*) FROM files WHERE status = 'normal'`).Scan(&stats.TotalFiles)
	_ = db.QueryRow(`SELECT COUNT(*) FROM files WHERE DATE(created_at) = CURDATE() AND status = 'normal'`).Scan(&stats.TodayUploads)
	_ = db.QueryRow(`SELECT COUNT(*) FROM files WHERE DATE(last_accessed_at) = CURDATE() AND status = 'normal'`).Scan(&stats.TodayAccess)
	_ = db.QueryRow(`SELECT COUNT(*) FROM files WHERE cache_expires_at > NOW() AND status = 'normal'`).Scan(&stats.CachedFiles)
	_ = db.QueryRow(`SELECT COUNT(*) FROM banned_ips`).Scan(&stats.BannedIPs)

	if stats.TotalFiles > 0 {
		stats.CacheHitRate = float64(stats.CachedFiles) / float64(stats.TotalFiles) * 100
		if stats.CacheHitRate > 100 {
			stats.CacheHitRate = 100
		}
	}

	_ = json.NewEncoder(w).Encode(stats)
}

func filesHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"message": "method not allowed"})
		return
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize := 20
	searchIP := strings.TrimSpace(r.URL.Query().Get("ip"))
	searchKeyword := strings.TrimSpace(r.URL.Query().Get("q"))

	resp := filesResponse{CurrentPage: page, Files: []fileRecord{}}
	countQuery := "SELECT COUNT(*) FROM files WHERE 1=1"
	countArgs := []interface{}{}
	if searchIP != "" {
		parsed := net.ParseIP(searchIP)
		if parsed == nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"message": "invalid ip"})
			return
		}
		countQuery += " AND upload_ip = ?"
		countArgs = append(countArgs, ipToBin(parsed))
	}
	if searchKeyword != "" {
		kw := "%" + searchKeyword + "%"
		countQuery += " AND (INET6_NTOA(upload_ip) LIKE ? OR random_path LIKE ? OR file_name LIKE ?)"
		countArgs = append(countArgs, kw, kw, kw)
	}

	if err := db.QueryRow(countQuery, countArgs...).Scan(&resp.TotalCount); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"message": "query failed"})
		return
	}
	if resp.TotalCount > 0 {
		resp.TotalPages = (resp.TotalCount + pageSize - 1) / pageSize
	}

	query := `
		SELECT id, random_path, file_id, file_unique_id, mime_type, file_size, file_name,
		       upload_ip, edge_ip, status, delete_reason, created_at, last_accessed_at
		FROM files
		WHERE 1=1`
	args := []interface{}{}
	if searchIP != "" {
		query += " AND upload_ip = ?"
		args = append(args, ipToBin(net.ParseIP(searchIP)))
	}
	if searchKeyword != "" {
		kw := "%" + searchKeyword + "%"
		query += " AND (INET6_NTOA(upload_ip) LIKE ? OR random_path LIKE ? OR file_name LIKE ?)"
		args = append(args, kw, kw, kw)
	}
	query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
	args = append(args, pageSize, (page-1)*pageSize)

	rows, err := db.Query(query, args...)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"message": "query failed"})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var file fileRecord
		var uploadIPBin, edgeIPBin []byte
		var fileName sql.NullString
		var deleteReason sql.NullString
		var createdAt time.Time
		var lastAccessedAt sql.NullTime

		err := rows.Scan(&file.ID, &file.RandomPath, &file.FileID, &file.FileUniqueID, &file.MimeType,
			&file.FileSize, &fileName, &uploadIPBin, &edgeIPBin, &file.Status, &deleteReason,
			&createdAt, &lastAccessedAt)
		if err != nil {
			continue
		}
		if fileName.Valid {
			file.FileName = fileName.String
		}
		if deleteReason.Valid {
			file.DeleteReason = deleteReason.String
		}
		file.CreatedAt = createdAt.Format("2006-01-02 15:04:05")
		if lastAccessedAt.Valid {
			file.LastAccessedAt = lastAccessedAt.Time.Format("2006-01-02 15:04:05")
		}
		if uploadIPBin != nil {
			file.UploadIP = net.IP(uploadIPBin).String()
		}
		if edgeIPBin != nil {
			file.EdgeIP = net.IP(edgeIPBin).String()
		}
		resp.Files = append(resp.Files, file)
	}

	_ = json.NewEncoder(w).Encode(resp)
}

func bannedListHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rows, err := db.Query(`SELECT ip, banned_at, reason FROM banned_ips ORDER BY banned_at DESC LIMIT 100`)
	if err != nil {
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	out := struct {
		BannedIPs []bannedIPRecord `json:"banned_ips"`
	}{BannedIPs: []bannedIPRecord{}}

	for rows.Next() {
		var ipBin []byte
		var bannedAt time.Time
		var reason sql.NullString
		if err := rows.Scan(&ipBin, &bannedAt, &reason); err != nil {
			continue
		}
		record := bannedIPRecord{IP: net.IP(ipBin).String(), BannedAt: bannedAt.Format("2006-01-02 15:04:05")}
		if reason.Valid {
			record.Reason = reason.String
		}
		out.BannedIPs = append(out.BannedIPs, record)
	}

	_ = json.NewEncoder(w).Encode(out)
}

func banHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req banRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "无效的请求格式"})
		return
	}
	ip := net.ParseIP(req.IP)
	if ip == nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "无效的IP地址格式"})
		return
	}

	var exists bool
	if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM banned_ips WHERE ip = ?)`, ipToBin(ip)).Scan(&exists); err != nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "检查失败"})
		return
	}
	if exists {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "该IP已被封禁"})
		return
	}

	if _, err := db.Exec(`INSERT INTO banned_ips (ip, banned_at, reason) VALUES (?, NOW(), ?)`, ipToBin(ip), req.Reason); err != nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "封禁失败"})
		return
	}
	_ = json.NewEncoder(w).Encode(apiResponse{Success: true, Message: fmt.Sprintf("IP %s 已封禁", req.IP)})
}

func unbanHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		IP string `json:"ip"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "无效的请求格式"})
		return
	}
	ip := net.ParseIP(req.IP)
	if ip == nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "无效的IP地址格式"})
		return
	}

	result, err := db.Exec(`DELETE FROM banned_ips WHERE ip = ?`, ipToBin(ip))
	if err != nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "解封失败"})
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "该IP不在封禁列表中"})
		return
	}
	_ = json.NewEncoder(w).Encode(apiResponse{Success: true, Message: fmt.Sprintf("IP %s 已解封", req.IP)})
}

func deleteHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req deleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "无效的请求格式"})
		return
	}
	if req.Path == "" {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "文件路径不能为空"})
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	if req.Reason == "" {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "删除原因不能为空"})
		return
	}

	result, err := db.Exec(`UPDATE files SET status = 'deleted', delete_reason = ? WHERE random_path = ? AND status = 'normal'`, req.Reason, req.Path)
	if err != nil {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "删除失败"})
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		_ = json.NewEncoder(w).Encode(apiResponse{Success: false, Message: "文件不存在或已被删除"})
		return
	}
	_ = json.NewEncoder(w).Encode(apiResponse{Success: true, Message: "文件已删除"})
}

// ================= 配置加载 =================

func loadConfig() {
	configPath := ConfigFile
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		// 尝试当前目录
		configPath = filepath.Join(filepath.Dir(os.Args[0]), ConfigFile)
	}

	f, err := os.Open(configPath)
	if err != nil {
		log.Fatalf("无法打开配置文件 %s: %v", configPath, err)
	}
	defer f.Close()

	config = &Config{}
	if err := json.NewDecoder(f).Decode(config); err != nil {
		log.Fatalf("配置文件格式错误: %v", err)
	}

	if _, err := strconv.ParseInt(config.Telegram.ChannelID, 10, 64); err != nil {
		log.Fatalf("无效的 Telegram Channel ID: %v", err)
	}

	// 验证是否配置了 API Keys
	if len(config.APIKeys) == 0 {
		log.Printf("[警告] 未配置 API Keys，管理后台将无法访问")
		log.Printf("[提示] 请在 data.json 中添加 \"api_keys\": [\"your-secret-key-here\"]")
	} else {
		log.Printf("[配置] 已加载 %d 个 API Key", len(config.APIKeys))
	}

	log.Printf("配置加载成功")
}

// ================= 数据库初始化 =================

func initDB() error {
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=true&loc=Local",
		config.MySQL.Username,
		config.MySQL.Password,
		config.MySQL.Host,
		config.MySQL.Port,
		config.MySQL.Database)

	var err error
	db, err = sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("打开数据库连接失败: %w", err)
	}

	// 连接池配置
	db.SetMaxOpenConns(50)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(time.Hour)

	// 测试连接
	if err := db.Ping(); err != nil {
		return fmt.Errorf("数据库连接测试失败: %w", err)
	}

	log.Println("数据库连接成功")
	return nil
}

// ================= Telegram API =================

// TGDocument Telegram文档对象
type TGDocument struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	FileSize     int64  `json:"file_size"`
}

// TGUploadResult Telegram上传结果
type TGUploadResult struct {
	MessageID int64      `json:"message_id"`
	Document  TGDocument `json:"document"`
}

// TGUploadResponse Telegram上传响应
type TGUploadResponse struct {
	OK     bool           `json:"ok"`
	Result TGUploadResult `json:"result"`
}

// TGFileResult Telegram文件信息结果
type TGFileResult struct {
	FilePath string `json:"file_path"`
}

// TGFileResponse Telegram文件信息响应
type TGFileResponse struct {
	OK     bool         `json:"ok"`
	Result TGFileResult `json:"result"`
}

// 上传文件到Telegram群组/频道
func tgUpload(data []byte, mimeType string, filename string) (fileID, fileUID string, err error) {
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	// 使用配置文件中的 channel_id 作为上传目标
	// 支持群组（负数）和频道（负数）
	log.Printf("[TG上传] 上传目标: chat_id=%s", config.Telegram.ChannelID)
	_ = writer.WriteField("chat_id", config.Telegram.ChannelID)
	_ = writer.WriteField("parse_mode", "") // 不使用解析模式

	part, err := writer.CreateFormFile("document", filename)
	if err != nil {
		return "", "", fmt.Errorf("创建表单文件失败: %w", err)
	}
	if _, err := part.Write(data); err != nil {
		return "", "", fmt.Errorf("写入文件数据失败: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", "", fmt.Errorf("关闭写入器失败: %w", err)
	}

	url := fmt.Sprintf("%s/bot%s/sendDocument", TGAPI, config.Telegram.BotToken)
	log.Printf("[TG上传] 请求URL: %s", url)
	req, err := http.NewRequest("POST", url, body)
	if err != nil {
		return "", "", fmt.Errorf("创建请求失败: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	client := &http.Client{Timeout: 60 * time.Second} // 增加超时时间
	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("发送请求失败: %w", err)
	}
	defer resp.Body.Close()

	// 读取响应体用于错误调试
	respBody, _ := io.ReadAll(resp.Body)
	log.Printf("[TG上传] API响应: %s", string(respBody))

	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("Telegram API 返回错误: %d, 响应: %s", resp.StatusCode, string(respBody))
	}

	var res TGUploadResponse
	if err := json.Unmarshal(respBody, &res); err != nil {
		return "", "", fmt.Errorf("解析响应失败: %w, 响应: %s", err, string(respBody))
	}
	if !res.OK {
		return "", "", fmt.Errorf("Telegram API 返回失败, 响应: %s", string(respBody))
	}

	log.Printf("[TG上传] 成功 file_id=%s, file_unique_id=%s", res.Result.Document.FileID, res.Result.Document.FileUniqueID)
	return res.Result.Document.FileID, res.Result.Document.FileUniqueID, nil
}

// 从Telegram下载文件
func tgDownload(fileID, dest string) error {
	// 1. 获取文件路径
	url := fmt.Sprintf("%s/bot%s/getFile?file_id=%s", TGAPI, config.Telegram.BotToken, fileID)
	log.Printf("[TG下载] 请求URL: %s", url)

	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("获取文件信息失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// 读取响应体获取错误详情
		body, _ := io.ReadAll(resp.Body)
		log.Printf("[TG下载] API错误响应: %s", string(body))
		return fmt.Errorf("getFile API 返回错误: %d, 响应: %s", resp.StatusCode, string(body))
	}

	var fileRes TGFileResponse
	if err := json.NewDecoder(resp.Body).Decode(&fileRes); err != nil {
		return fmt.Errorf("解析文件信息失败: %w", err)
	}
	if !fileRes.OK || fileRes.Result.FilePath == "" {
		return errors.New("getFile 返回无效结果")
	}

	log.Printf("[TG下载] 文件路径: %s", fileRes.Result.FilePath)

	// 2. 下载文件内容
	downloadURL := fmt.Sprintf("%s/file/bot%s/%s", TGAPI, config.Telegram.BotToken, fileRes.Result.FilePath)
	log.Printf("[TG下载] 下载URL: %s", downloadURL)

	dlResp, err := http.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("下载文件失败: %w", err)
	}
	defer dlResp.Body.Close()

	if dlResp.StatusCode != http.StatusOK {
		return fmt.Errorf("文件下载返回错误: %d", dlResp.StatusCode)
	}

	// 3. 写入本地缓存
	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("创建缓存文件失败: %w", err)
	}
	defer f.Close()

	if _, err := io.Copy(f, dlResp.Body); err != nil {
		return fmt.Errorf("写入缓存文件失败: %w", err)
	}

	log.Printf("[TG下载] 下载成功: %s", dest)
	return nil
}

// ================= 缓存清理 =================

func cacheCleaner() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		cleanExpiredCache()
	}
}

func cleanExpiredCache() {
	// 查询过期的缓存文件
	rows, err := db.Query(`
		SELECT random_path 
		FROM files 
		WHERE cache_expires_at < NOW() AND status = 'normal'
	`)
	if err != nil {
		log.Printf("[缓存清理] 查询失败: %v", err)
		return
	}
	defer rows.Close()

	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		paths = append(paths, path)
	}

	if len(paths) == 0 {
		return
	}

	log.Printf("[缓存清理] 发现 %d 个过期缓存", len(paths))

	// 并发删除缓存文件
	var wg sync.WaitGroup
	sem := make(chan struct{}, 10) // 限制并发数

	for _, path := range paths {
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			cachePath := filepath.Join(CacheDir, p)
			if err := os.Remove(cachePath); err != nil && !os.IsNotExist(err) {
				log.Printf("[缓存清理] 删除失败 %s: %v", p, err)
			}
		}(path)
	}

	wg.Wait()
	log.Printf("[缓存清理] 完成")
}

// ================= 工具函数 =================

// 获取客户端真实IP
func getClientIP(r *http.Request) net.IP {
	// 优先读取 EO-Client-IP
	if ip := r.Header.Get("EO-Client-IP"); ip != "" {
		if parsed := net.ParseIP(ip); parsed != nil {
			return parsed
		}
	}

	// 兼容 X-Forwarded-For
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		if parsed := net.ParseIP(strings.TrimSpace(ips[0])); parsed != nil {
			return parsed
		}
	}

	// 回退到 RemoteAddr
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return nil
	}
	return net.ParseIP(host)
}

// 获取边缘节点IP（CDN IP）
func getEdgeIP(r *http.Request) net.IP {
	// 优先读取 EO-Client-IP 头（腾讯云 CDN 边缘节点 IP）
	if ip := r.Header.Get("EO-Client-IP"); ip != "" {
		if parsed := net.ParseIP(ip); parsed != nil {
			return parsed
		}
	}

	// 回退到 RemoteAddr
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return nil
	}
	return net.ParseIP(host)
}

// IP转二进制
func ipToBin(ip net.IP) []byte {
	if ip == nil {
		return nil
	}
	return ip.To16()
}

// 检查IP是否被封禁，返回封禁原因（空字符串表示未封禁）
func isBanned(ip net.IP) string {
	if ip == nil {
		return ""
	}

	var reason string
	err := db.QueryRow(`SELECT reason FROM banned_ips WHERE ip = ?`, ipToBin(ip)).Scan(&reason)
	if err != nil {
		return ""
	}
	if reason == "" {
		return "被封禁"
	}
	return reason
}

// 生成随机路径
func randPath(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}

// 检查文件是否存在
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

package main

import (
	"bytes"
	"context"
	"database/sql"
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

	"tg-imagebed/admin"

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
		ChannelID string `json:"channel_id"` // 群组ID或频道ID，群组为负数，如 -1001234567890
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
}

var (
	config     *Config
	db         *sql.DB
	adminIDs   map[int64]bool
	tgChannelID int64
)

// ======================================================

func main() {
	loadConfig()
	if err := initDB(); err != nil {
		log.Fatalf("数据库初始化失败: %v", err)
	}

	// 初始化管理员认证
	admin.InitAdminAuth()

	if err := os.MkdirAll(CacheDir, 0755); err != nil {
		log.Fatalf("创建缓存目录失败: %v", err)
	}

	// 启动缓存清理协程
	go cacheCleaner()

	// 初始化随机数生成器
	rand.Seed(time.Now().UnixNano())

	mux := http.NewServeMux()
	mux.HandleFunc("/upload", uploadHandler)
	mux.HandleFunc("/", fetchHandler)

	// 管理后台 API 路由（使用 Basic Auth 认证）
	mux.HandleFunc("/admin.html", admin.BasicAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "admin/index.html")
	}))
	mux.HandleFunc("/api/stats", admin.BasicAuthMiddleware(admin.StatsHandler(db)))
	mux.HandleFunc("/api/files", admin.BasicAuthMiddleware(admin.FilesHandler(db)))
	mux.HandleFunc("/api/banned", admin.BasicAuthMiddleware(admin.BannedListHandler(db)))
	mux.HandleFunc("/api/ban", admin.BasicAuthMiddleware(admin.BanHandler(db)))
	mux.HandleFunc("/api/unban", admin.BasicAuthMiddleware(admin.UnbanHandler(db)))
	mux.HandleFunc("/api/delete", admin.BasicAuthMiddleware(admin.DeleteHandler(db)))

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

	var fileID, mimeType, fileName string
	var expire time.Time

	// 查询文件信息（FOR UPDATE 行锁）
	err = tx.QueryRow(`
		SELECT file_id, mime_type, file_name, cache_expires_at
		FROM files
		WHERE random_path = ? AND status = 'normal'
		FOR UPDATE`, path).
		Scan(&fileID, &mimeType, &fileName, &expire)
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

	// 解析 Channel ID
	tgChannelID, err = strconv.ParseInt(config.Telegram.ChannelID, 10, 64)
	if err != nil {
		log.Fatalf("无效的 Telegram Channel ID: %v", err)
	}

	// 初始化管理员ID集合
	adminIDs = make(map[int64]bool)
	for _, id := range config.Admin.UserIDs {
		adminIDs[id] = true
	}

	log.Printf("配置加载成功, ChannelID: %d, 管理员数: %d", tgChannelID, len(adminIDs))
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
	FileSize    int64  `json:"file_size"`
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
	OK     bool        `json:"ok"`
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

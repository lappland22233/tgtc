package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"
)

// 配置
const (
	ConfigPath      = "data.json"
	CacheDir        = "/data/cache"
	CacheTTL        = 10 * 60 // 10分钟
	ServerAddr      = "127.0.0.1:8082"
	MinFreeSpaceGB  = 8        // 软限制：小于 8GB 启动清理模式
	HardLimitGB     = 4        // 硬限制：预测下载后空间小于 4GB 则拒绝
)

// Config 配置结构体
type Config struct {
	Telegram struct {
		BotToken  string `json:"bot_token"`
		ChannelID string `json:"channel_id"`
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
	BotAPIDataDir string `json:"bot_api_data_dir"` // Bot API 本地数据目录
}

// FileInfo 文件信息
type FileInfo struct {
	ID             int        `db:"id"`
	RandomPath     string     `db:"random_path"`
	FileID         string     `db:"file_id"`
	FileUniqueID   string     `db:"file_unique_id"`
	MimeType       string     `db:"mime_type"`
	FileSize       int64      `db:"file_size"`
	FileName       *string    `db:"file_name"`
	CacheExpiresAt *time.Time `db:"cache_expires_at"`
	LastAccessedAt *time.Time `db:"last_accessed_at"`
}

// TGFileResponse Telegram文件响应
type TGFileResponse struct {
	OK          bool    `json:"ok"`
	Result      TGFile  `json:"result"`
	Description string  `json:"description"`
}

type TGFile struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	FileSize     int64  `json:"file_size"`
	FilePath     string `json:"file_path"`
}

// Server HTTP服务器
type Server struct {
	config          *Config
	db              *sqlx.DB
	client          *http.Client
	minFreeSpace    uint64
	cacheLock       sync.Mutex          // 缓存清理互斥锁
	downloads       sync.Map            // fileID -> *downloadTask，防止并发重复下载
	lowSpaceCleaning int32               // 低水位清理标志（0=未启动，1=正在运行）
}

// downloadTask 下载任务
type downloadTask struct {
	done      chan struct{} // 完成通知通道
	err       error         // 错误信息
	startTime time.Time     // 开始时间
}

// NewServer 创建服务器实例
func NewServer() (*Server, error) {
	// 加载配置
	config, err := loadConfig()
	if err != nil {
		return nil, err
	}

	// 连接数据库
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		config.MySQL.Username,
		config.MySQL.Password,
		config.MySQL.Host,
		config.MySQL.Port,
		config.MySQL.Database,
	)
	db, err := sqlx.Connect("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("数据库连接失败: %v", err)
	}

	// HTTP 客户端配置（设置20分钟超时，支持大文件的 getFile 阻塞调用）
	client := &http.Client{
		Timeout: 20 * time.Minute,
		Transport: &http.Transport{
			IdleConnTimeout: 90 * time.Second,
		},
	}

	return &Server{
		config:       config,
		db:           db,
		client:       client,
		minFreeSpace: MinFreeSpaceGB * 1024 * 1024 * 1024,
	}, nil
}

// loadConfig 加载配置文件
func loadConfig() (*Config, error) {
	data, err := os.ReadFile(ConfigPath)
	if err != nil {
		return nil, fmt.Errorf("配置文件不存在: %v", err)
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("配置文件解析失败: %v", err)
	}

	return &config, nil
}

// getFileByPath 根据路径查询文件（移除 FOR UPDATE）
func (s *Server) getFileByPath(randomPath string) (*FileInfo, error) {
	var file FileInfo
	err := s.db.Get(&file, `SELECT id, random_path, file_id, file_unique_id, mime_type, file_size, file_name, cache_expires_at, last_accessed_at FROM files WHERE random_path = ? AND status = 'normal'`, randomPath)
	if err != nil {
		return nil, err
	}
	return &file, nil
}

// updateLastAccessed 只更新访问时间，不刷新过期时间
func (s *Server) updateLastAccessed(fileID int) error {
	_, err := s.db.Exec(`UPDATE files SET last_accessed_at = NOW() WHERE id = ?`, fileID)
	return err
}

// setCacheExpiresAt 首次缓存完成时设置过期时间（只设置一次）
func (s *Server) setCacheExpiresAt(fileID int) error {
	// 设置新的过期时间（当前时间往后推10分钟）
	expiresAt := time.Now().Add(10 * time.Minute)

	// 去掉 IS NULL 限制，允许覆盖旧的时间戳
	_, err := s.db.Exec(`UPDATE files SET cache_expires_at = ? WHERE id = ?`, expiresAt, fileID)
	if err != nil {
		return fmt.Errorf("刷新过期时间失败: %v", err)
	}
	return nil
}

// isBanned 检查IP是否被封禁
func (s *Server) isBanned(ipBytes []byte) (string, error) {
	var reason string
	err := s.db.Get(&reason, "SELECT reason FROM banned_ips WHERE ip = ?", ipBytes)
	if err != nil {
		return "", nil
	}
	if reason == "" {
		reason = "被封禁"
	}
	return reason, nil
}

// isCacheValid 检查缓存是否有效
func (s *Server) isCacheValid(fileInfo *FileInfo, cacheFile string) bool {
	// 1. 检查物理文件
	fileStat, err := os.Stat(cacheFile)
	if err != nil {
		return false
	}
	if fileStat.Size() == 0 {
		return false
	}

	// 2. 检查时间
	if fileInfo.CacheExpiresAt == nil {
		return true // 只要文件在，没设过期时间也算有效
	}

	// 判定逻辑
	isValid := time.Now().Before(fileInfo.CacheExpiresAt.Add(10 * time.Second))
	if !isValid {
		log.Printf("[缓存] 文件已过期: 路径=%s, 过期时间=%s, 当前时间=%s",
			fileInfo.RandomPath, fileInfo.CacheExpiresAt.Format("15:04:05"), time.Now().Format("15:04:05"))
	}
	return isValid
}

// serveFile 返回缓存文件（通过 nginx）
func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, fileInfo *FileInfo, path string) {
	mimeType := fileInfo.MimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	// 更新访问时间
	s.updateLastAccessed(fileInfo.ID)

	filename := "download"
	if fileInfo.FileName != nil && *fileInfo.FileName != "" {
		filename = *fileInfo.FileName
	}

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename*=UTF-8''%s", url.PathEscape(filename)))
	w.Header().Set("Cache-Control", "public, max-age=259200, immutable")
	w.Header().Set("X-Accel-Redirect", "/internal-cache/"+path)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
}

// prepareCache 后台准备缓存（从 Bot API 本地文件复制）
func (s *Server) prepareCache(fileInfo *FileInfo, task *downloadTask) {
	defer close(task.done)
	defer s.downloads.Delete(fileInfo.FileUniqueID)

	cacheFile := filepath.Join(CacheDir, fileInfo.RandomPath)

	// 先检查本地文件是否已存在（可能被其他请求或清理逻辑影响）
	if fileExists(cacheFile) {
		log.Printf("[后台] 本地文件已存在，跳过准备: %s", fileInfo.RandomPath)
		return
	}

	log.Printf("[后台] 开始请求 Telegram 准备文件: %s", fileInfo.FileID)

	// 调用阻塞的 getFile，Bot API 会先下载文件到本地
	tgFile, err := s.getTGFile(fileInfo.FileID)
	if err != nil {
		log.Printf("[后台] getFile 失败: %v", err)
		task.err = err
		return
	}

	log.Printf("[后台] getFile 返回，文件路径: %s", tgFile.FilePath)

	// 判断路径类型，智能拼接
	var sourcePath string
	if filepath.IsAbs(tgFile.FilePath) {
		// 如果 Bot API 返回的是绝对路径（如 /opt/telegram-bot-api/...），直接使用
		sourcePath = tgFile.FilePath
	} else {
		// 如果返回的是相对路径，再进行拼接
		localRoot := s.config.BotAPIDataDir
		if localRoot == "" {
			localRoot = "/var/lib/telegram-bot-api"
		}
		sourcePath = filepath.Join(localRoot, s.config.Telegram.BotToken, tgFile.FilePath)
	}

	log.Printf("[后台] 确定源文件路径: %s", sourcePath)

	// 检查源文件是否存在
	if _, err := os.Stat(sourcePath); err != nil {
		log.Printf("[后台] Bot API 本地文件不存在: %s (错误: %v)", sourcePath, err)
		task.err = err
		return
	}

	// 执行原子性复制
	if err := s.copyLocalFile(sourcePath, cacheFile); err != nil {
		log.Printf("[后台] 复制到缓存失败: %v", err)
		task.err = err
		return
	}

	// 更新数据库状态
	if err := s.setCacheExpiresAt(fileInfo.ID); err != nil {
		log.Printf("[后台] 更新数据库失败: %v", err)
		task.err = err
		return
	}

	log.Printf("[后台] 文件准备就绪: %s", fileInfo.RandomPath)
}

// copyLocalFile 原子性复制文件
func (s *Server) copyLocalFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	tmpDst := dst + ".tmp"
	sf, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sf.Close()

	df, err := os.Create(tmpDst)
	if err != nil {
		return err
	}

	if _, err := io.Copy(df, sf); err != nil {
		df.Close()
		os.Remove(tmpDst)
		return err
	}
	df.Close()

	return os.Rename(tmpDst, dst)
}

// getTGFile 获取Telegram文件信息
func (s *Server) getTGFile(fileID string) (*TGFile, error) {
	botAPIURL := "http://127.0.0.1:8081"
	url := fmt.Sprintf("%s/bot%s/getFile", botAPIURL, s.config.Telegram.BotToken)
	resp, err := s.client.PostForm(url, map[string][]string{"file_id": {fileID}})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result TGFileResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	if !result.OK {
		return nil, fmt.Errorf("getFile失败: %s", result.Description)
	}

	return &result.Result, nil
}

// getDiskFreeSpace 获取磁盘剩余空间（字节）
func (s *Server) getDiskFreeSpace() (uint64, error) {
	var stat syscall.Statfs_t
	err := syscall.Statfs(CacheDir, &stat)
	if err != nil {
		return 0, err
	}
	return stat.Bavail * uint64(stat.Bsize), nil
}

// checkDiskSpace 检查磁盘空间，不足时清理过期缓存（加锁）
func (s *Server) checkDiskSpace() {
	s.cacheLock.Lock()
	defer s.cacheLock.Unlock()

	freeSpace, err := s.getDiskFreeSpace()
	if err != nil {
		log.Printf("[缓存] 获取磁盘空间失败: %v", err)
		return
	}

	freeSpaceGB := float64(freeSpace) / (1024 * 1024 * 1024)
	log.Printf("[缓存] 剩余空间: %.2f GB", freeSpaceGB)

	if freeSpace < s.minFreeSpace {
		log.Printf("[缓存] 空间不足（%.2f GB < %d GB），开始清理过期缓存...", freeSpaceGB, MinFreeSpaceGB)
		s.cleanExpiredCache()
	}
}

// cleanExpiredCache 清理已过期的缓存（调用前已加锁）
func (s *Server) cleanExpiredCache() {
	// 查询已过期的缓存文件
	type expiredFile struct {
		RandomPath string `db:"random_path"`
	}
	var expiredFiles []expiredFile
	err := s.db.Select(&expiredFiles, `SELECT random_path FROM files WHERE cache_expires_at < NOW() ORDER BY cache_expires_at ASC LIMIT 100`)
	if err != nil {
		log.Printf("[缓存] 查询过期缓存失败: %v", err)
		return
	}

	if len(expiredFiles) == 0 {
		log.Printf("[缓存] 没有过期缓存可清理")
		return
	}

	deletedCount := 0
	freedSpace := int64(0)

	for _, file := range expiredFiles {
		cachePath := filepath.Join(CacheDir, file.RandomPath)

		// 先获取文件大小用于统计（必须先 stat！）
		if info, err := os.Stat(cachePath); err == nil {
			freedSpace += info.Size()
		} else if !os.IsNotExist(err) {
			// 文件存在但 stat 失败，跳过
			log.Printf("[缓存] stat 失败 %s: %v", cachePath, err)
			continue
		}

		// 删除缓存文件
		if err := os.Remove(cachePath); err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[缓存] 删除失败 %s: %v", cachePath, err)
			}
			continue
		}

		// 更新数据库：清除过期时间
		_, _ = s.db.Exec(`UPDATE files SET cache_expires_at = NULL WHERE random_path = ?`, file.RandomPath)
		deletedCount++
		log.Printf("[缓存] 删除过期缓存: %s", file.RandomPath)
	}

	log.Printf("[缓存] 清理完成，删除 %d 个过期文件，释放 %.2f GB", deletedCount, float64(freedSpace)/(1024*1024*1024))
}

// startLowSpaceCleaner 启动低水位清理协程（30秒一次）
func (s *Server) startLowSpaceCleaner() {
	if !atomic.CompareAndSwapInt32(&s.lowSpaceCleaning, 0, 1) {
		return // 已经在跑
	}
	log.Printf("[缓存] 进入低水位模式，启动后台清理")

	go func() {
		defer atomic.StoreInt32(&s.lowSpaceCleaning, 0)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			<-ticker.C
			s.checkDiskSpace()

			free, err := s.getDiskFreeSpace()
			if err != nil {
				log.Printf("[缓存] 获取磁盘空间失败: %v", err)
				continue
			}

			if free >= s.minFreeSpace {
				log.Printf("[缓存] 剩余空间恢复至安全值，停止后台清理")
				return
			}

			log.Printf("[缓存] 后台清理中，当前剩余 %.2f GB", float64(free)/(1024*1024*1024))
		}
	}()
}

// getClientIP 获取客户端真实IP
func getClientIP(r *http.Request) net.IP {
	if ip := r.Header.Get("EO-Client-IP"); ip != "" {
		if parsed := net.ParseIP(ip); parsed != nil {
			return parsed
		}
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		if parsed := net.ParseIP(strings.TrimSpace(ips[0])); parsed != nil {
			return parsed
		}
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if parsed := net.ParseIP(host); parsed != nil {
		return parsed
	}
	return nil
}

// handleFile 处理文件访问请求
func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")

	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}

	log.Printf("[访问] 路径: %s", path)

	if path == "" {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	clientIP := getClientIP(r)
	log.Printf("[访问] 路径: %s, IP: %s", path, clientIP)

	if clientIP != nil {
		banReason, err := s.isBanned(clientIP)
		if err == nil && banReason != "" {
			log.Printf("[访问] IP已封禁: %s, 原因: %s", clientIP, banReason)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{
				"error":  "forbidden",
				"reason": banReason,
			})
			return
		}
	}

	fileInfo, err := s.getFileByPath(path)
	if err != nil || fileInfo == nil {
		log.Printf("[访问] 文件不存在: %s", path)
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	cacheFile := filepath.Join(CacheDir, path)

	// 1. 只要本地文件存在，就直接提供下载（不管是否过期）
	if fileExists(cacheFile) {
		log.Printf("[访问] 本地文件存在，直接提供下载: %s", path)
		s.serveFile(w, r, fileInfo, path)
		return
	}

	// 本地文件不存在，触发空间检查和后台准备
	s.checkDiskSpace()

	// --- 新增：预测逻辑 ---
	free, err := s.getDiskFreeSpace()
	if err == nil {
		// 计算预测剩余空间 (当前字节 - 文件库记录的大小)
		predictedFree := int64(free) - fileInfo.FileSize
		hardLimitBytes := int64(HardLimitGB * 1024 * 1024 * 1024)

		if predictedFree < hardLimitBytes {
			log.Printf("[拒绝] 空间预警: 当前 %.2f GB, 文件 %.2f MB, 下载后预计仅剩 %.2f GB (低于硬限额 %d GB)",
				float64(free)/(1024*1024*1024),
				float64(fileInfo.FileSize)/(1024*1024),
				float64(predictedFree)/(1024*1024*1024),
				HardLimitGB)

			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusInsufficientStorage) // 507 存储不足
			json.NewEncoder(w).Encode(map[string]string{
				"status":  "error",
				"message": "服务器繁忙请等待10分钟后再尝试",
			})
			return
		}
	}
	// ---------------------

	// 2. 检查或创建下载任务
	taskIface, loaded := s.downloads.LoadOrStore(fileInfo.FileUniqueID, &downloadTask{
		done:      make(chan struct{}),
		startTime: time.Now(),
	})
	task := taskIface.(*downloadTask)

	if !loaded {
		log.Printf("[访问] 启动后台准备任务: %s", fileInfo.FileID)
		go s.prepareCache(fileInfo, task)
	}

	// 3. 核心改进：等待任务完成
	select {
	case <-task.done:
		// 任务在等待期间完成了！
		if task.err == nil {
			// 重新获取最新的数据库信息
			latestInfo, _ := s.getFileByPath(path)
			if latestInfo != nil && fileExists(cacheFile) {
				log.Printf("[访问] 任务完成，本地文件存在，提供下载: %s", path)
				s.serveFile(w, r, latestInfo, path)
				return
			} else {
				log.Printf("[警告] 后台任务完成但文件不存在: %s", path)
			}
		}
	case <-time.After(5 * time.Second):
		// 只等 5 秒，如果 5 秒还没好，再给 202，让用户下次再来
	}

	// 4. 只有等不及了才返回 202
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "preparing",
		"message": "文件正在准备中，请稍后刷新。准备完成后只保留10分钟请及时下载",
	})
}

// Run 启动服务器
func (s *Server) Run() error {
	if err := os.MkdirAll(CacheDir, 0755); err != nil {
		return fmt.Errorf("创建缓存目录失败: %v", err)
	}

	srv := &http.Server{
		Addr:         ServerAddr,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0,   // 大文件必须 0
		IdleTimeout:  60 * time.Second,
	}

	http.HandleFunc("/", s.handleFile)

	log.Printf("缓存目录: %s", CacheDir)
	log.Printf("服务启动监听: %s", ServerAddr)

	return srv.ListenAndServe()
}

// startActiveCleaner 启动 30 秒定期清理协程
func (s *Server) startActiveCleaner() {
	log.Printf("[系统] 启动 30 秒定期清理协程")
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			// 主动执行空间检查，如果小于 MinFreeSpaceGB (8GB) 则清理过期文件
			s.checkDiskSpace()
		}
	}()
}

func main() {
	server, err := NewServer()
	if err != nil {
		log.Fatalf("创建服务器失败: %v", err)
	}

	// 1. 启动时先查一次
	server.checkDiskSpace()

	// 2. 启动 30 秒主动清理任务
	server.startActiveCleaner()

	if err := server.Run(); err != nil {
		log.Fatalf("服务器运行失败: %v", err)
	}
}

func fileExists(filename string) bool {
	info, err := os.Stat(filename)
	if os.IsNotExist(err) {
		return false
	}
	return !info.IsDir()
}

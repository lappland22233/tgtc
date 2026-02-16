package admin

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ================= 管理后台 API =================

// StatsResponse 统计信息响应
type StatsResponse struct {
	TotalFiles   int     `json:"total_files"`
	TodayUploads int     `json:"today_uploads"`
	TodayAccess  int     `json:"today_access"`
	CachedFiles  int     `json:"cached_files"`
	BannedIPs    int     `json:"banned_ips"`
	CacheHitRate float64 `json:"cache_hit_rate"`
}

// FileRecord 文件记录
type FileRecord struct {
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

// FilesResponse 文件列表响应
type FilesResponse struct {
	Files       []FileRecord `json:"files"`
	CurrentPage int          `json:"current_page"`
	TotalPages  int          `json:"total_pages"`
	TotalCount  int          `json:"total_count"`
}

// BannedIPRecord 封禁IP记录
type BannedIPRecord struct {
	IP       string `json:"ip"`
	BannedAt string `json:"banned_at"`
	Reason   string `json:"reason"`
}

// BannedListResponse 封禁列表响应
type BannedListResponse struct {
	BannedIPs []BannedIPRecord `json:"banned_ips"`
}

// APIResponse 通用API响应
type APIResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// BanRequest 封禁请求
type BanRequest struct {
	IP     string `json:"ip"`
	Reason string `json:"reason"`
}

// DeleteRequest 删除请求
type DeleteRequest struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// 获取统计信息
func StatsHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		stats := StatsResponse{}

		// 文件总数
		err := db.QueryRow(`
			SELECT COUNT(*) 
			FROM files 
			WHERE status = 'normal'
		`).Scan(&stats.TotalFiles)
		if err != nil {
			log.Printf("[统计] 查询文件总数失败: %v", err)
		}

		// 今日上传数
		err = db.QueryRow(`
			SELECT COUNT(*) 
			FROM files 
			WHERE DATE(created_at) = CURDATE() AND status = 'normal'
		`).Scan(&stats.TodayUploads)
		if err != nil {
			log.Printf("[统计] 查询今日上传失败: %v", err)
		}

		// 今日访问量
		err = db.QueryRow(`
			SELECT COUNT(*) 
			FROM files 
			WHERE DATE(last_accessed_at) = CURDATE() AND status = 'normal'
		`).Scan(&stats.TodayAccess)
		if err != nil {
			log.Printf("[统计] 查询今日访问失败: %v", err)
		}

		// 缓存中文件数
		err = db.QueryRow(`
			SELECT COUNT(*) 
			FROM files 
			WHERE cache_expires_at > NOW() AND status = 'normal'
		`).Scan(&stats.CachedFiles)
		if err != nil {
			log.Printf("[统计] 查询缓存文件失败: %v", err)
		}

		// 封禁 IP 数
		err = db.QueryRow(`
			SELECT COUNT(*) 
			FROM banned_ips
		`).Scan(&stats.BannedIPs)
		if err != nil {
			log.Printf("[统计] 查询封禁IP失败: %v", err)
		}

		// 缓存命中率
		if stats.TotalFiles > 0 {
			stats.CacheHitRate = float64(stats.CachedFiles) / float64(stats.TotalFiles) * 100
			if stats.CacheHitRate > 100 {
				stats.CacheHitRate = 100
			}
		}

		json.NewEncoder(w).Encode(stats)
	}
}

// 获取文件列表
func FilesHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// 获取分页参数
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		pageSize := 20

		// 获取搜索参数
		searchIP := r.URL.Query().Get("ip")

		response := FilesResponse{
			CurrentPage: page,
			Files:       []FileRecord{},
		}

		// 构建查询
		query := `
			SELECT 
				id, random_path, file_id, file_unique_id, 
				mime_type, file_size, file_name, 
				upload_ip, edge_ip, status, delete_reason,
				created_at, last_accessed_at
			FROM files
			WHERE 1=1
		`
		args := []interface{}{}

		if searchIP != "" {
			query += " AND upload_ip = ?"
			args = append(args, ipToBin(net.ParseIP(searchIP)))
		}

		// 查询总数
		countQuery := "SELECT COUNT(*) FROM files WHERE 1=1"
		countArgs := []interface{}{}
		if searchIP != "" {
			countQuery += " AND upload_ip = ?"
			countArgs = append(countArgs, ipToBin(net.ParseIP(searchIP)))
		}
		err := db.QueryRow(countQuery, countArgs...).Scan(&response.TotalCount)
		if err != nil {
			log.Printf("[文件列表] 查询总数失败: %v", err)
		}

		// 计算总页数
		if response.TotalCount > 0 {
			response.TotalPages = (response.TotalCount + pageSize - 1) / pageSize
		}

		// 查询文件列表
		query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
		offset := (page - 1) * pageSize
		args = append(args, pageSize, offset)

		rows, err := db.Query(query, args...)
		if err != nil {
			log.Printf("[文件列表] 查询失败: %v", err)
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		for rows.Next() {
			var file FileRecord
			var uploadIPBin, edgeIPBin []byte

			err := rows.Scan(
				&file.ID, &file.RandomPath, &file.FileID, &file.FileUniqueID,
				&file.MimeType, &file.FileSize, &file.FileName,
				&uploadIPBin, &edgeIPBin, &file.Status, &file.DeleteReason,
				&file.CreatedAt, &file.LastAccessedAt,
			)
			if err != nil {
				log.Printf("[文件列表] 扫描记录失败: %v", err)
				continue
			}

			// 转换IP地址
			if uploadIPBin != nil {
				file.UploadIP = net.IP(uploadIPBin).String()
			}
			if edgeIPBin != nil {
				file.EdgeIP = net.IP(edgeIPBin).String()
			}

			// 格式化时间
			file.CreatedAt = formatDateTime(file.CreatedAt)
			file.LastAccessedAt = formatDateTime(file.LastAccessedAt)

			response.Files = append(response.Files, file)
		}

		json.NewEncoder(w).Encode(response)
	}
}

// 获取封禁IP列表
func BannedListHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		response := BannedListResponse{
			BannedIPs: []BannedIPRecord{},
		}

		query := `
			SELECT ip, banned_at, reason
			FROM banned_ips
			ORDER BY banned_at DESC
			LIMIT 100
		`

		rows, err := db.Query(query)
		if err != nil {
			log.Printf("[封禁列表] 查询失败: %v", err)
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		for rows.Next() {
			var ipBin []byte
			var record BannedIPRecord
			var bannedAt time.Time
			var reason sql.NullString

			err := rows.Scan(&ipBin, &bannedAt, &reason)
			if err != nil {
				log.Printf("[封禁列表] 扫描记录失败: %v", err)
				continue
			}

			record.IP = net.IP(ipBin).String()
			record.BannedAt = bannedAt.Format("2006-01-02 15:04:05")
			if reason.Valid {
				record.Reason = reason.String
			}

			response.BannedIPs = append(response.BannedIPs, record)
		}

		json.NewEncoder(w).Encode(response)
	}
}

// 封禁IP
func BanHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req BanRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "无效的请求格式",
			})
			return
		}

		// 验证IP地址
		ip := net.ParseIP(req.IP)
		if ip == nil {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "无效的IP地址格式",
			})
			return
		}

		// 检查是否已存在
		var exists bool
		err := db.QueryRow(`
			SELECT EXISTS(SELECT 1 FROM banned_ips WHERE ip = ?)
		`, ipToBin(ip)).Scan(&exists)
		if err != nil {
			log.Printf("[封禁] 检查失败: %v", err)
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "检查失败",
			})
			return
		}

		if exists {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "该IP已被封禁",
			})
			return
		}

		// 插入封禁记录
		_, err = db.Exec(`
			INSERT INTO banned_ips (ip, banned_at, reason)
			VALUES (?, NOW(), ?)
		`, ipToBin(ip), req.Reason)
		if err != nil {
			log.Printf("[封禁] 插入失败: %v", err)
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "封禁失败",
			})
			return
		}

		log.Printf("[封禁] IP %s 已封禁, 原因: %s", req.IP, req.Reason)

		json.NewEncoder(w).Encode(APIResponse{
			Success: true,
			Message: fmt.Sprintf("IP %s 已封禁", req.IP),
		})
	}
}

// 解封IP
func UnbanHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			IP string `json:"ip"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "无效的请求格式",
			})
			return
		}

		// 验证IP地址
		ip := net.ParseIP(req.IP)
		if ip == nil {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "无效的IP地址格式",
			})
			return
		}

		// 删除封禁记录
		result, err := db.Exec(`
			DELETE FROM banned_ips WHERE ip = ?
		`, ipToBin(ip))
		if err != nil {
			log.Printf("[解封] 删除失败: %v", err)
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "解封失败",
			})
			return
		}

		affected, _ := result.RowsAffected()
		if affected == 0 {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "该IP不在封禁列表中",
			})
			return
		}

		log.Printf("[解封] IP %s 已解封", req.IP)

		json.NewEncoder(w).Encode(APIResponse{
			Success: true,
			Message: fmt.Sprintf("IP %s 已解封", req.IP),
		})
	}
}

// 删除文件
func DeleteHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req DeleteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "无效的请求格式",
			})
			return
		}

		if req.Path == "" {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "文件路径不能为空",
			})
			return
		}

		req.Reason = strings.TrimSpace(req.Reason)
		if req.Reason == "" {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "删除原因不能为空",
			})
			return
		}

		// 标记文件为已删除状态
		result, err := db.Exec(`
			UPDATE files
			SET status = 'deleted', delete_reason = ?
			WHERE random_path = ? AND status = 'normal'
		`, req.Reason, req.Path)
		if err != nil {
			log.Printf("[删除] 更新失败: %v", err)
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "删除失败",
			})
			return
		}

		affected, _ := result.RowsAffected()
		if affected == 0 {
			json.NewEncoder(w).Encode(APIResponse{
				Success: false,
				Message: "文件不存在或已被删除",
			})
			return
		}

		log.Printf("[删除] 文件 %s 已标记删除", req.Path)

		json.NewEncoder(w).Encode(APIResponse{
			Success: true,
			Message: "文件已删除",
		})
	}
}

// IP转二进制
func ipToBin(ip net.IP) []byte {
	if ip == nil {
		return nil
	}
	return ip.To16()
}

// 格式化日期时间
func formatDateTime(s string) string {
	t, err := time.Parse("2006-01-02 15:04:05", s)
	if err != nil {
		return s
	}
	return t.Format("2006-01-02 15:04:05")
}

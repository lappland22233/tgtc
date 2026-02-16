package admin

import (
	"crypto/subtle"
	"encoding/base64"
	"log"
	"net/http"
	"strings"
)

// ================= 管理后台认证 =================

// 管理员认证配置（生产环境应从配置文件读取）
var (
	AdminUsername string
	AdminPassword string
)

// 初始化管理员认证配置
func InitAdminAuth() {
	// 从配置文件读取管理员凭据（可选）
	// 默认使用简单的用户名密码
	// 生产环境强烈建议使用强密码

	AdminUsername = "admin"
	AdminPassword = "changeme123" // ⚠️ 请修改为强密码！

	log.Printf("[认证] 管理员认证已启用（用户名: %s）", AdminUsername)
	log.Printf("[安全提示] 请确保修改 admin/auth.go 中的默认密码")
}

// 基本认证中间件
func BasicAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// 检查是否已经通过认证（Session或Token）
		// 这里使用 HTTP Basic Auth 作为简单实现
		username, password, ok := r.BasicAuth()
		if !ok {
			w.Header().Set("WWW-Authenticate", `Basic realm="TG图床后台管理"`)
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte("需要认证"))
			return
		}

		// 验证用户名密码（使用 constant-time 比较防止时序攻击）
		usernameValid := subtle.ConstantTimeCompare([]byte(username), []byte(AdminUsername)) == 1
		passwordValid := subtle.ConstantTimeCompare([]byte(password), []byte(AdminPassword)) == 1

		if !usernameValid || !passwordValid {
			log.Printf("[认证] 认证失败: %s from %s", username, r.RemoteAddr)
			w.Header().Set("WWW-Authenticate", `Basic realm="TG图床后台管理"`)
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte("认证失败"))
			return
		}

		log.Printf("[认证] 认证成功: %s from %s", username, r.RemoteAddr)
		next(w, r)
	}
}

// 简单的Token认证中间件（可选）
func TokenAuthMiddleware(validToken string) func(http.HandlerFunc) http.HandlerFunc {
	// 预定义的访问Token（生产环境应从配置文件读取）
	if validToken == "" {
		validToken = "your-secret-token-change-me"
	}

	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				w.Header().Set("WWW-Authenticate", `Bearer realm="TG图床后台管理"`)
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte("需要认证"))
				return
			}

			// 解析Bearer Token
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				w.Header().Set("WWW-Authenticate", `Bearer realm="TG图床后台管理"`)
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte("无效的认证格式"))
				return
			}

			token := parts[1]

			// 验证Token
			if token != validToken {
				log.Printf("[认证] Token验证失败 from %s", r.RemoteAddr)
				w.Header().Set("WWW-Authenticate", `Bearer realm="TG图床后台管理"`)
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte("认证失败"))
				return
			}

			log.Printf("[认证] Token认证成功 from %s", r.RemoteAddr)
			next(w, r)
		}
	}
}

// IP白名单认证中间件（可选）
func IPWhitelistMiddleware(allowedIPs []string) func(http.HandlerFunc) http.HandlerFunc {
	// 允许的IP列表（示例）
	if len(allowedIPs) == 0 {
		allowedIPs = []string{
			"127.0.0.1",
			"::1",
		}
	}

	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			// 获取客户端IP
			clientIP := getClientIPFromRequest(r)
			if clientIP == nil {
				http.Error(w, "无法获取客户端IP", http.StatusForbidden)
				return
			}

			// 检查IP是否在白名单中
			allowed := false
			clientIPStr := clientIP.String()
			for _, allowedIP := range allowedIPs {
				if clientIPStr == allowedIP {
					allowed = true
					break
				}
			}

			if !allowed {
				log.Printf("[认证] IP不在白名单: %s", clientIPStr)
				http.Error(w, "访问被拒绝", http.StatusForbidden)
				return
			}

			log.Printf("[认证] IP白名单验证通过: %s", clientIPStr)
			next(w, r)
		}
	}
}

// 获取客户端IP（辅助函数）
func getClientIPFromRequest(r *http.Request) net.IP {
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

// 解码Basic Auth
func DecodeBasicAuth(auth string) (username, password string, ok bool) {
	const prefix = "Basic "
	if !strings.HasPrefix(auth, prefix) {
		return "", "", false
	}

	c, err := base64.StdEncoding.DecodeString(auth[len(prefix):])
	if err != nil {
		return "", "", false
	}

	cs := string(c)
	s := strings.IndexByte(cs, ':')
	if s < 0 {
		return "", "", false
	}

	return cs[:s], cs[s+1:], true
}

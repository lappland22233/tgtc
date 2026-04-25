package middleware

import (
	"net"
	"net/http"
	"strings"

	"github.com/tg-imagebed-refactored/internal/repository"
)

// NewBanIPMiddleware 创建IP封禁中间件。
func NewBanIPMiddleware(banRepo repository.BanRepository) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			ip := getClientIP(r)
			if ip != nil {
				isBanned, _, err := banRepo.IsBanned(r.Context(), ip)
				if err != nil {
					http.Error(w, "failed to check ip ban status", http.StatusInternalServerError)
					return
				}
				if isBanned {
					http.Error(w, "ip is banned", http.StatusForbidden)
					return
				}
			}

			next.ServeHTTP(w, r)
		}
	}
}

func getClientIP(r *http.Request) net.IP {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			if ip := net.ParseIP(strings.TrimSpace(parts[0])); ip != nil {
				return ip
			}
		}
	}

	if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
		if ip := net.ParseIP(xrip); ip != nil {
			return ip
		}
	}

	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil {
		if ip := net.ParseIP(host); ip != nil {
			return ip
		}
	}

	if ip := net.ParseIP(strings.TrimSpace(r.RemoteAddr)); ip != nil {
		return ip
	}

	return nil
}

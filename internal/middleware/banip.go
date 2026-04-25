package middleware

import (
	"net"
	"net/http"
	"os"
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
	remoteIP := parseRemoteIP(r.RemoteAddr)
	if remoteIP == nil {
		return nil
	}

	trustedProxies := parseTrustedProxies(os.Getenv("TRUSTED_PROXY_CIDRS"))
	if !isTrustedProxy(remoteIP, trustedProxies) {
		return remoteIP
	}

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

	return remoteIP
}

func parseRemoteIP(remoteAddr string) net.IP {
	trimmed := strings.TrimSpace(remoteAddr)
	host, _, err := net.SplitHostPort(trimmed)
	if err == nil {
		if ip := net.ParseIP(host); ip != nil {
			return ip
		}
	}

	if ip := net.ParseIP(trimmed); ip != nil {
		return ip
	}

	return nil
}

func parseTrustedProxies(raw string) []*net.IPNet {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	trusted := make([]*net.IPNet, 0)
	for _, item := range strings.Split(raw, ",") {
		entry := strings.TrimSpace(item)
		if entry == "" {
			continue
		}

		if ip := net.ParseIP(entry); ip != nil {
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			trusted = append(trusted, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}

		_, network, err := net.ParseCIDR(entry)
		if err == nil {
			trusted = append(trusted, network)
		}
	}
	return trusted
}

func isTrustedProxy(ip net.IP, trusted []*net.IPNet) bool {
	for _, network := range trusted {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

package middleware

import (
	"net/http/httptest"
	"testing"
)

func TestGetClientIP_IgnoresForwardHeadersFromUntrustedRemote(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "")

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "198.51.100.10:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.5")
	req.Header.Set("X-Real-IP", "203.0.113.6")

	ip := getClientIP(req)
	if ip == nil || ip.String() != "198.51.100.10" {
		t.Fatalf("expected remote ip 198.51.100.10, got %v", ip)
	}
}

func TestGetClientIP_UsesForwardHeadersFromTrustedProxy(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "10.0.0.0/8")

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.10.10.10:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.5, 10.10.10.10")

	ip := getClientIP(req)
	if ip == nil || ip.String() != "203.0.113.5" {
		t.Fatalf("expected forwarded ip 203.0.113.5, got %v", ip)
	}
}

func TestGetClientIP_FallsBackToRemoteOnInvalidForwardHeaders(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "10.0.0.0/8")

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.10.10.10:1234"
	req.Header.Set("X-Forwarded-For", "not-an-ip")
	req.Header.Set("X-Real-IP", "also-not-an-ip")

	ip := getClientIP(req)
	if ip == nil || ip.String() != "10.10.10.10" {
		t.Fatalf("expected remote ip fallback 10.10.10.10, got %v", ip)
	}
}

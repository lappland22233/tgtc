package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSMiddleware_ReleaseModeRejectsUnknownOrigin(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "")

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	h := CORSMiddleware("release", next)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d", http.StatusForbidden, rr.Code)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no wildcard allow-origin, got %q", got)
	}
}

func TestCORSMiddleware_DebugModeAllowsAnyOriginWhenUnset(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "")

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	h := CORSMiddleware("debug", next)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://dev.example")
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rr.Code)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("expected wildcard allow-origin, got %q", got)
	}
}

func TestCORSMiddleware_ReleaseModeAllowsConfiguredOrigin(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "https://app.example, https://admin.example")

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	h := CORSMiddleware("release", next)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://admin.example")
	rr := httptest.NewRecorder()

	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rr.Code)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "https://admin.example" {
		t.Fatalf("expected reflected origin, got %q", got)
	}
}

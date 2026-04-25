package middleware

import (
	"math"
	"net/http"
	"sync"
	"time"
)

type tokenBucket struct {
	tokens     float64
	lastRefill time.Time
}

// RateLimiter IP级令牌桶限流器。
type RateLimiter struct {
	capacity     float64
	refillPerSec float64
	buckets      map[string]*tokenBucket
	mu           sync.Mutex
	expireAfter  time.Duration
}

// NewRateLimiter 创建一个按分钟配置的令牌桶限流器。
func NewRateLimiter(limitPerMinute int) *RateLimiter {
	capacity := float64(limitPerMinute)
	return &RateLimiter{
		capacity:     capacity,
		refillPerSec: capacity / 60.0,
		buckets:      make(map[string]*tokenBucket),
		expireAfter:  10 * time.Minute,
	}
}

// Middleware 返回限流中间件。
func (l *RateLimiter) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := getClientIP(r)
		if ip == nil {
			http.Error(w, "unable to determine client ip", http.StatusBadRequest)
			return
		}

		if !l.allow(ip.String(), time.Now()) {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	}
}

func (l *RateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	for ip, bucket := range l.buckets {
		if now.Sub(bucket.lastRefill) > l.expireAfter {
			delete(l.buckets, ip)
		}
	}

	bucket, ok := l.buckets[key]
	if !ok {
		bucket = &tokenBucket{tokens: l.capacity, lastRefill: now}
		l.buckets[key] = bucket
	}

	elapsed := now.Sub(bucket.lastRefill).Seconds()
	bucket.tokens = math.Min(l.capacity, bucket.tokens+elapsed*l.refillPerSec)
	bucket.lastRefill = now

	if bucket.tokens < 1 {
		return false
	}

	bucket.tokens--
	return true
}

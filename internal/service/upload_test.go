package service

import "testing"

func TestDeriveUploadDir(t *testing.T) {
	tests := []struct {
		name     string
		cacheDir string
		want     string
	}{
		{
			name:     "absolute cache dir uses sibling uploads dir",
			cacheDir: "/data/cache",
			want:     "/data/cache_uploads",
		},
		{
			name:     "relative cache dir uses sibling uploads dir",
			cacheDir: "cache",
			want:     "cache_uploads",
		},
		{
			name:     "current directory cache dir falls back to cache_uploads",
			cacheDir: ".",
			want:     "cache_uploads",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveUploadDir(tt.cacheDir)
			if got != tt.want {
				t.Fatalf("deriveUploadDir(%q) = %q, want %q", tt.cacheDir, got, tt.want)
			}
		})
	}
}

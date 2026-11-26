package core

import (
	"testing"
	"time"
)

func TestProxyTimeout(t *testing.T) {
	cases := []struct {
		target string
		want   time.Duration
	}{
		{"/api/v1/system/info", 120 * time.Second},
		{"/api/v1/sites/apply", 120 * time.Second},
		{"/api/v1/images/pull", 620 * time.Second},
		{"/api/v1/files/download?root=files&path=/a", 620 * time.Second},
		{"/api/v1/files/upload", 620 * time.Second},
		{"/api/v1/files/archive", 620 * time.Second},
		{"/api/v1/files/extract", 620 * time.Second},
		{"/api/v1/databases/backups/bk_1/download", 620 * time.Second},
		{"/api/v1/stacks/mpanel-caddy/up", 620 * time.Second},
		{"/api/v1/stacks/mpanel-caddy/pull", 620 * time.Second},
		{"/api/v1/stacks/mpanel-caddy/down", 120 * time.Second},
	}
	for _, tc := range cases {
		if got := proxyTimeout(tc.target); got != tc.want {
			t.Errorf("proxyTimeout(%q) = %v, want %v", tc.target, got, tc.want)
		}
	}
}

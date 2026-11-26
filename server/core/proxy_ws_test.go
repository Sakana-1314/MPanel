package core

import "testing"

func TestIsProxyWSPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/api/v1/machines/m_1/proxy/ws/terminal/term_1", true},
		{"/api/v1/machines/m_1/proxy/ws/containers/abc/logs", true},
		{"/api/v1/machines/m_1/proxy/system/info", false},
		{"/api/v1/machines/m_1/proxy/files/download", false},
		{"/api/v1/machines", false},
	}
	for _, tc := range cases {
		if got := isProxyWSPath(tc.path); got != tc.want {
			t.Errorf("isProxyWSPath(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

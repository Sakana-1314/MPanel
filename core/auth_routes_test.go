package core

import "testing"

func TestNormalizeWSTicketPath(t *testing.T) {
	cases := []struct {
		machineID string
		path      string
		want      string
		ok        bool
	}{
		{"m_1", "/ws/terminal/term_1", "/ws/terminal/term_1", true},
		{"m_1", "/api/v1/machines/m_1/proxy/ws/terminal/term_1", "/ws/terminal/term_1", true},
		{"m_1", "/api/v1/machines/m_1/proxy/ws/containers/abc/logs", "/ws/containers/abc/logs", true},
		{"m_1", "/api/v1/machines/m_2/proxy/ws/terminal/term_1", "", false},
		{"m_1", "/api/v1/machines/m_1/proxy/sites", "", false},
		{"m_1", "/api/v1/machines/m_1/proxy/ws", "", false},
		{"m_1", "/sites", "", false},
		{"m_1", "", "", false},
	}
	for _, tc := range cases {
		got, ok := normalizeWSTicketPath(tc.machineID, tc.path)
		if got != tc.want || ok != tc.ok {
			t.Fatalf("normalizeWSTicketPath(%q, %q) = (%q, %v), want (%q, %v)",
				tc.machineID, tc.path, got, ok, tc.want, tc.ok)
		}
	}
}

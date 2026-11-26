package core

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCopyResponseStripsUpstreamCORS(t *testing.T) {
	upstream := &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Access-Control-Allow-Origin":      {"http://127.0.0.1:5173"},
			"Access-Control-Allow-Credentials": {"true"},
			"Content-Type":                     {"application/json"},
			"Vary":                             {"Origin"},
		},
		Body: io.NopCloser(strings.NewReader(`{"ok":true}`)),
	}
	recorder := httptest.NewRecorder()
	copyResponse(recorder, upstream)

	for _, key := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials"} {
		if value := recorder.Header().Get(key); value != "" {
			t.Fatalf("%s 不应从 agent 透传，得到 %q", key, value)
		}
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type 丢失: %q", got)
	}
	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"ok":true}` {
		t.Fatalf("响应体错误: %d %q", recorder.Code, recorder.Body.String())
	}
}

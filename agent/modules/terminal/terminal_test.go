package terminal

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/core/config"
	"github.com/sakana-1314/mpanel/core/protocol"
)

type testEnvelope struct {
	OK    bool               `json:"ok"`
	Data  json.RawMessage    `json:"data"`
	Error *protocol.APIError `json:"error"`
}

func newTestModule(t *testing.T) (*Module, *http.ServeMux, *config.Agent, *agent.WSRegistry) {
	t.Helper()
	base := t.TempDir()
	cfg := &config.Agent{Agent: config.AgentSystem{
		BaseDir: base,
		DataDir: filepath.Join(base, "data"),
		Version: "test",
	}}
	mux := http.NewServeMux()
	registry := agent.NewWSRegistry()
	module := New()
	ctx := &agent.Context{
		Mux:    mux,
		WS:     registry,
		Cfg:    cfg,
		Runner: agent.NewRunner(),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if err := module.Register(ctx); err != nil {
		t.Fatalf("Register: %v", err)
	}
	return module, mux, cfg, registry
}

func doJSON(t *testing.T, mux *http.ServeMux, method, target string, body any) (int, testEnvelope) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	var envelope testEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode %s %s response %q: %v", method, target, recorder.Body.String(), err)
	}
	return recorder.Code, envelope
}

func TestShellsAndSessionLifecycle(t *testing.T) {
	_, mux, cfg, registry := newTestModule(t)
	if _, ok := registry.MatchWS("/ws/terminal/example"); !ok {
		t.Fatal("terminal WS prefix was not registered")
	}

	status, envelope := doJSON(t, mux, http.MethodGet, "/api/v1/terminal/shells", nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("shells status=%d error=%+v", status, envelope.Error)
	}
	var shells protocol.ListResult[ShellInfo]
	if err := json.Unmarshal(envelope.Data, &shells); err != nil {
		t.Fatalf("decode shells: %v", err)
	}
	if !shells.Available || len(shells.Items) == 0 {
		t.Fatalf("expected available shells, got %+v", shells)
	}

	status, envelope = doJSON(t, mux, http.MethodPost, "/api/v1/terminal/sessions", map[string]any{
		"cwd":  cfg.Agent.BaseDir,
		"cols": 100,
		"rows": 30,
	})
	if status != http.StatusCreated || !envelope.OK {
		t.Fatalf("create status=%d error=%+v", status, envelope.Error)
	}
	var created SessionInfo
	if err := json.Unmarshal(envelope.Data, &created); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if created.ID == "" || created.Status != statusRunning {
		t.Fatalf("unexpected session: %+v", created)
	}
	if created.Cols != 100 || created.Rows != 30 {
		t.Fatalf("size not applied: %+v", created)
	}
	if created.PTY != (runtime.GOOS != "windows") {
		t.Fatalf("pty mismatch on %s: %+v", runtime.GOOS, created)
	}

	status, envelope = doJSON(t, mux, http.MethodGet, "/api/v1/terminal/sessions/"+created.ID, nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("get status=%d error=%+v", status, envelope.Error)
	}

	status, envelope = doJSON(t, mux, http.MethodGet, "/api/v1/terminal/sessions", nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("list status=%d error=%+v", status, envelope.Error)
	}
	var sessions protocol.ListResult[SessionInfo]
	if err := json.Unmarshal(envelope.Data, &sessions); err != nil {
		t.Fatalf("decode sessions: %v", err)
	}
	if len(sessions.Items) != 1 || sessions.Items[0].ID != created.ID {
		t.Fatalf("unexpected session list: %+v", sessions.Items)
	}

	status, envelope = doJSON(t, mux, http.MethodDelete, "/api/v1/terminal/sessions/"+created.ID, nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("delete status=%d error=%+v", status, envelope.Error)
	}
	var closed struct {
		Closed bool   `json:"closed"`
		ID     string `json:"id"`
	}
	if err := json.Unmarshal(envelope.Data, &closed); err != nil || !closed.Closed || closed.ID != created.ID {
		t.Fatalf("unexpected delete result: %+v err=%v", closed, err)
	}

	status, _ = doJSON(t, mux, http.MethodGet, "/api/v1/terminal/sessions/"+created.ID, nil)
	if status != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", status)
	}
}

func TestSessionRejectsCwdOutsideAllowedRoots(t *testing.T) {
	_, mux, _, _ := newTestModule(t)
	outside := "/etc"
	if runtime.GOOS == "windows" {
		outside = os.Getenv("SystemRoot")
		if outside == "" {
			outside = `C:\Windows`
		}
	}
	status, envelope := doJSON(t, mux, http.MethodPost, "/api/v1/terminal/sessions", map[string]any{
		"cwd": outside,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for outside cwd %q, got %d (%+v)", outside, status, envelope.Error)
	}
}

func TestSessionRejectsUnknownShell(t *testing.T) {
	_, mux, _, _ := newTestModule(t)
	status, envelope := doJSON(t, mux, http.MethodPost, "/api/v1/terminal/sessions", map[string]any{
		"shell": filepath.Join(os.TempDir(), "definitely-not-a-shell-xyz"),
	})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown shell, got %d (%+v)", status, envelope.Error)
	}
}

// TestWebSocketTerminalFlow exercises the ready/ping/pong/input/output/exit
// framing over a real WebSocket, including DELETE closing the session.
func TestWebSocketTerminalFlow(t *testing.T) {
	_, mux, cfg, registry := newTestModule(t)
	shell := "/bin/sh"
	if runtime.GOOS == "windows" {
		shell = "cmd.exe"
		if resolved, err := exec.LookPath(shell); err == nil {
			shell = resolved
		}
	}
	status, envelope := doJSON(t, mux, http.MethodPost, "/api/v1/terminal/sessions", map[string]any{
		"shell": shell,
		"cwd":   cfg.Agent.BaseDir,
	})
	if status != http.StatusCreated || !envelope.OK {
		t.Fatalf("create status=%d error=%+v", status, envelope.Error)
	}
	var created SessionInfo
	if err := json.Unmarshal(envelope.Data, &created); err != nil {
		t.Fatalf("decode session: %v", err)
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler, ok := registry.MatchWS(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		handler(conn, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/terminal/" + created.ID
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", wsURL, err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))

	readUntil := func(want string) map[string]any {
		t.Helper()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				t.Fatalf("read while waiting for %s: %v", want, err)
			}
			var message map[string]any
			if err := json.Unmarshal(data, &message); err != nil {
				continue
			}
			if message["type"] == want {
				return message
			}
		}
	}

	if ready := readUntil("ready"); ready["session"] == nil {
		t.Fatal("ready frame missing session")
	}
	if err := conn.WriteJSON(map[string]any{"type": "ping"}); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	readUntil("pong")
	if err := conn.WriteJSON(map[string]any{"type": "input", "data": "echo __MPANEL_WS_MARKER__\r\n"}); err != nil {
		t.Fatalf("write input: %v", err)
	}
	found := false
	for !found {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read output: %v", err)
		}
		var message struct {
			Type string `json:"type"`
			Data string `json:"data"`
		}
		if json.Unmarshal(data, &message) == nil && message.Type == "output" && strings.Contains(message.Data, "__MPANEL_WS_MARKER__") {
			found = true
		}
	}

	status, envelope = doJSON(t, mux, http.MethodDelete, "/api/v1/terminal/sessions/"+created.ID, nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("delete status=%d error=%+v", status, envelope.Error)
	}
	exit := readUntil("exit")
	if _, ok := exit["code"]; !ok {
		t.Fatalf("exit frame missing code: %+v", exit)
	}
}

func TestWebSocketMissingSessionCloses4404(t *testing.T) {
	_, _, _, registry := newTestModule(t)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler, ok := registry.MatchWS(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		handler(conn, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/terminal/term_missing"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = conn.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != 4404 {
		t.Fatalf("expected close 4404, got %v", err)
	}
}

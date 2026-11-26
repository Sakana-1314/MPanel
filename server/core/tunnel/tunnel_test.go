package tunnel

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

type echoMatcher struct {
	handler WSHandler
}

func (m echoMatcher) MatchWS(string) (WSHandler, bool) { return m.handler, m.handler != nil }

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestStreamRequestResponseAndWebSocket(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path":   r.URL.Path,
			"method": r.Method,
			"body":   string(body),
		})
	})
	wsHandler := func(conn protocol.WSConn, r *http.Request) {
		defer conn.Close()
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			_ = conn.WriteMessage(kind, []byte("echo:"+string(data)))
		}
	}

	serverSide, clientSide := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	server := NewServer(nil)
	session, err := server.ServeStream(ctx, "m_test", serverSide, serverSide)
	if err != nil {
		t.Fatalf("ServeStream: %v", err)
	}
	client := &Client{
		MachineID: "m_test",
		Handler:   handler,
		WS:        echoMatcher{handler: wsHandler},
	}
	go func() { _ = client.ServeStdio(ctx, clientSide, clientSide) }()

	waitFor(t, 2*time.Second, func() bool { return server.Online("m_test") })
	time.Sleep(50 * time.Millisecond)

	resp, err := session.Do(ctx, http.MethodPost, "/api/v1/echo", nil, []byte("hello"))
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload["path"] != "/api/v1/echo" || payload["body"] != "hello" || payload["method"] != "POST" {
		t.Fatalf("unexpected payload: %#v", payload)
	}

	conn, err := session.OpenWS(ctx, "/ws/echo", nil)
	if err != nil {
		t.Fatalf("OpenWS: %v", err)
	}
	defer conn.Close()
	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("ws write: %v", err)
	}
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ws read: %v", err)
	}
	if string(data) != "echo:ping" {
		t.Fatalf("ws payload = %q", string(data))
	}
}

func TestLargeBodyChunking(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_, _ = w.Write([]byte(strings.Repeat("x", len(body))))
	})
	serverSide, clientSide := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := NewServer(nil)
	session, err := server.ServeStream(ctx, "m_chunk", serverSide, serverSide)
	if err != nil {
		t.Fatalf("ServeStream: %v", err)
	}
	client := &Client{MachineID: "m_chunk", Handler: handler}
	go func() { _ = client.ServeStdio(ctx, clientSide, clientSide) }()
	waitFor(t, 2*time.Second, func() bool { return server.Online("m_chunk") })
	time.Sleep(50 * time.Millisecond)

	payload := []byte(strings.Repeat("y", protocol.ChunkBytes*2+123))
	resp, err := session.Do(ctx, http.MethodPost, "/api/v1/upload", nil, payload)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if len(body) != len(payload) {
		t.Fatalf("response length = %d, want %d", len(body), len(payload))
	}
}

func TestStdioSessionClosesOnPipeBreak(t *testing.T) {
	serverSide, clientSide := net.Pipe()
	server := NewServer(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session, err := server.ServeStream(ctx, "m_close", serverSide, serverSide)
	if err != nil {
		t.Fatalf("ServeStream: %v", err)
	}
	_ = clientSide.Close()
	select {
	case <-session.Closed():
	case <-time.After(2 * time.Second):
		t.Fatal("session did not close after pipe break")
	}
	// Closed may be signalled just before the registry entry is removed;
	// poll instead of reading the map on the same tick.
	waitFor(t, 2*time.Second, func() bool { return !server.Online("m_close") })
}

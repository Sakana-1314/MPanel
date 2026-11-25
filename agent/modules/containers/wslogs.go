package containers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

const wsLogsPrefix = "/ws/containers/"

// wsLogLine is one {type:'log'} frame of the container log stream.
type wsLogLine struct {
	Type   string `json:"type"`
	Stream string `json:"stream"`
	Data   string `json:"data"`
	TS     string `json:"ts,omitempty"`
}

type wsLogEnd struct {
	Type string `json:"type"`
}

type wsLogError struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type wsLogWriter struct {
	mu     sync.Mutex
	conn   protocol.WSConn
	broken bool
}

func (w *wsLogWriter) send(value any) bool {
	data, err := json.Marshal(value)
	if err != nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.broken {
		return false
	}
	if deadliner, ok := w.conn.(interface{ SetWriteDeadline(time.Time) error }); ok {
		_ = deadliner.SetWriteDeadline(time.Now().Add(10 * time.Second))
	}
	if err := w.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		w.broken = true
		return false
	}
	return true
}

func (w *wsLogWriter) logLine(stream, data, ts string) bool {
	return w.send(wsLogLine{Type: "log", Stream: stream, Data: data, TS: ts})
}

func (w *wsLogWriter) errorEvent(code protocol.ErrorCode, message string) {
	_ = w.send(wsLogError{Type: "error", Code: string(code), Message: message})
}

func (w *wsLogWriter) end() {
	_ = w.send(wsLogEnd{Type: "end"})
}

func closeWSConn(conn protocol.WSConn, code int, reason string) {
	if control, ok := conn.(interface {
		WriteControl(int, []byte, time.Time) error
	}); ok {
		_ = control.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason), time.Now().Add(2*time.Second))
	}
	_ = conn.Close()
}

func parseWSLogsPath(path string) (string, bool) {
	if !strings.HasPrefix(path, wsLogsPrefix) {
		return "", false
	}
	rest := strings.TrimPrefix(path, wsLogsPrefix)
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] != "logs" {
		return "", false
	}
	return parts[0], true
}

// handleContainerLogsWS implements WS /ws/containers/{id}/logs. The docker
// child process is tied to the connection context: a client close frame (or a
// dropped socket) cancels it, and the Runner kills the process.
func (m *Module) handleContainerLogsWS(conn protocol.WSConn, r *http.Request) {
	defer func() { _ = conn.Close() }()

	id, ok := parseWSLogsPath(r.URL.Path)
	if !ok || !validContainerRef(id) {
		writer := &wsLogWriter{conn: conn}
		writer.errorEvent(protocol.CodeNotFound, "容器不存在或日志路径不合法")
		closeWSConn(conn, protocol.WSCloseNotFound, "container not found")
		return
	}
	options, pErr := parseContainerLogsQuery(r.URL.Query(), true)
	if pErr != nil {
		writer := &wsLogWriter{conn: conn}
		writer.errorEvent(pErr.Code, pErr.Message)
		closeWSConn(conn, protocol.WSCloseProtocolError, "bad log query")
		return
	}
	available, reason := m.docker.check(r.Context())
	if !available {
		writer := &wsLogWriter{conn: conn}
		writer.errorEvent(protocol.CodeUnavailable, "Docker 不可用："+reason)
		closeWSConn(conn, protocol.WSCloseUpstreamDown, "docker unavailable")
		return
	}
	writer := &wsLogWriter{conn: conn}
	if !options.Stdout && !options.Stderr {
		writer.end()
		closeWSConn(conn, protocol.WSCloseNormal, "")
		return
	}

	if limiter, ok := conn.(interface{ SetReadLimit(int64) }); ok {
		limiter.SetReadLimit(protocol.MaxWSMessageBytes)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// A close frame from the browser or a dropped connection cancels the docker
	// child process. ReadMessage returns once the handler closes the socket.
	go func() {
		for {
			messageType, data, err := conn.ReadMessage()
			if err != nil {
				cancel()
				return
			}
			if messageType != websocket.TextMessage && messageType != websocket.BinaryMessage {
				continue
			}
			var message struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(data, &message) == nil && message.Type == "close" {
				cancel()
				return
			}
		}
	}()

	args := buildLogsArgs(id, options, options.Follow)
	res, err := m.docker.runner.Stream(ctx, m.docker.bin, args, func(line string) {
		if !options.Stdout {
			return
		}
		ts, data := splitLogTimestamp(line, options.Timestamps)
		if !writer.logLine("stdout", data, ts) {
			// The client stopped reading: kill docker logs instead of buffering
			// forever.
			cancel()
		}
	})
	if ctx.Err() != nil {
		// Client asked to close or the request context ended; the child process
		// has already been killed by CommandContext.
		return
	}
	if err != nil {
		writer.errorEvent(protocol.CodeUnavailable, "无法启动 docker logs："+err.Error())
		closeWSConn(conn, protocol.WSCloseUpstreamDown, "docker logs failed")
		return
	}
	if res.Code != 0 {
		if isNoSuchContainerOutput(res) {
			writer.errorEvent(protocol.CodeNotFound, "容器不存在")
			closeWSConn(conn, protocol.WSCloseNotFound, "container not found")
			return
		}
		reason := firstNonEmptyLine(res.Stderr, res.Stdout)
		if reason == "" {
			reason = "docker logs 非零退出"
		}
		writer.errorEvent(protocol.CodeUpstreamError, reason)
		closeWSConn(conn, protocol.WSCloseInternal, "docker logs failed")
		return
	}
	if options.Stderr && res.Stderr != "" {
		for _, line := range splitLogLines(res.Stderr) {
			ts, data := splitLogTimestamp(line, options.Timestamps)
			if !writer.logLine("stderr", data, ts) {
				return
			}
		}
	}
	writer.end()
	closeWSConn(conn, protocol.WSCloseNormal, "")
}

func splitLogLines(stream string) []string {
	stream = strings.TrimRight(stream, "\n")
	if stream == "" {
		return nil
	}
	return strings.Split(stream, "\n")
}

// splitLogTimestamp separates the docker --timestamps prefix from the actual
// log payload so the client receives ts separately (contract §9.2).
func splitLogTimestamp(line string, timestamps bool) (ts, data string) {
	if !timestamps {
		return "", line
	}
	idx := strings.IndexByte(line, ' ')
	if idx < 0 {
		if _, ok := parseDockerTime(line); ok {
			return line, ""
		}
		return "", line
	}
	token := line[:idx]
	if _, ok := parseDockerTime(token); !ok {
		return "", line
	}
	return token, strings.TrimPrefix(line[idx+1:], " ")
}

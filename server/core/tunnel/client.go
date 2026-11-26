package tunnel

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// Client is the agent side of a tunnel: it dials the core (reverse-ws) or
// serves frames on stdio, and dispatches tunneled requests into a local handler.
type Client struct {
	MachineID string
	Secret    string
	CoreURL   string // http(s)://host:port or ws(s)://host/ws/worker
	Worker    protocol.WorkerDescriptor
	Handler   http.Handler
	WS        WSMatcher
	Logger    *slog.Logger
	Insecure  bool
	OnConnect func()

	writeMu   sync.Mutex
	conn      *websocket.Conn
	stdioSend SendFunc

	mu      sync.Mutex
	uploads map[string]*uploadStream
	wsConns map[string]*clientWS
}

func (c *Client) log() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *Client) getConn() *websocket.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn
}

func (c *Client) send(frame *protocol.Frame) error {
	data, err := protocol.EncodeFrame(frame)
	if err != nil {
		return err
	}
	c.mu.Lock()
	conn := c.conn
	stdioSend := c.stdioSend
	c.mu.Unlock()
	if conn != nil {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return conn.WriteMessage(websocket.TextMessage, data)
	}
	if stdioSend != nil {
		return stdioSend(frame)
	}
	return errors.New("tunnel 未连接")
}

/* ------------------------------ reverse-ws ------------------------------- */

// Run dials the core and keeps the tunnel alive until ctx is canceled.
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		wsURL, err := c.wsURL()
		if err != nil {
			return err
		}
		dialer := websocket.Dialer{
			HandshakeTimeout: 15 * time.Second,
			Subprotocols:     []string{protocol.TunnelSubprotocol},
			TLSClientConfig:  &tls.Config{InsecureSkipVerify: c.Insecure}, //nolint:gosec // explicit dev switch
		}
		header := http.Header{}
		header.Set("Authorization", "Bearer "+c.Secret)
		conn, _, err := dialer.DialContext(ctx, wsURL, header)
		if err != nil {
			c.log().Warn("连接 core 失败，稍后重试", "error", err.Error(), "retryIn", backoff.String())
			if !sleep(ctx, backoff) {
				return nil
			}
			backoff = nextBackoff(backoff)
			continue
		}
		c.mu.Lock()
		c.conn = conn
		c.mu.Unlock()
		backoff = time.Second
		c.log().Info("已连接 core", "url", wsURL, "machineId", c.MachineID)

		_ = c.send(&protocol.Frame{
			Kind:      protocol.FrameHello,
			V:         protocol.ProtocolVersion,
			Role:      "worker",
			MachineID: c.MachineID,
			Worker:    &c.Worker,
			Protocol:  limitsPtr(protocol.DefaultLimits()),
			SentAt:    time.Now().UTC().Format(time.RFC3339),
		})
		if c.OnConnect != nil {
			c.OnConnect()
		}
		c.readLoop(ctx, conn)
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
		_ = conn.Close()
		if ctx.Err() != nil {
			return nil
		}
		if !sleep(ctx, backoff) {
			return nil
		}
		backoff = nextBackoff(backoff)
	}
}

func (c *Client) wsURL() (string, error) {
	raw := strings.TrimSpace(c.CoreURL)
	if raw == "" {
		return "", errors.New("未配置 MPANEL_CORE_URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", errors.New("core 地址必须是 http(s) 或 ws(s)")
	}
	path := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(path, "/ws/worker") {
		path = "/ws/worker"
	}
	u.Path = path
	u.RawQuery = ""
	return u.String(), nil
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) {
	for {
		_ = conn.SetReadDeadline(time.Now().Add(protocol.HeartbeatTimeoutSec * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		frame, err := protocol.DecodeFrame(data)
		if err != nil {
			c.log().Warn("丢弃非法隧道帧", "error", err.Error())
			continue
		}
		c.handleFrame(ctx, frame)
	}
}

/* -------------------------------- stdio ---------------------------------- */

// ServeStdio serves frames on a byte stream (core-spawned stdio mode).
func (c *Client) ServeStdio(ctx context.Context, r io.Reader, w io.Writer) error {
	var writeMu sync.Mutex
	stdioSend := func(frame *protocol.Frame) error {
		data, err := protocol.EncodeFrame(frame)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_, err = w.Write(append(data, '\n'))
		return err
	}
	c.mu.Lock()
	c.stdioSend = stdioSend
	c.mu.Unlock()
	_ = stdioSend(&protocol.Frame{
		Kind:      protocol.FrameHello,
		V:         protocol.ProtocolVersion,
		Role:      "worker",
		MachineID: c.MachineID,
		Worker:    &c.Worker,
		Protocol:  limitsPtr(protocol.DefaultLimits()),
		SentAt:    time.Now().UTC().Format(time.RFC3339),
	})
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), protocol.MaxFrameBytes+1024)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		frame, err := protocol.DecodeFrame(line)
		if err != nil {
			continue
		}
		c.handleFrame(ctx, frame)
	}
	return scanner.Err()
}

/* ------------------------------ frame router ----------------------------- */

type uploadStream struct {
	pipe *io.PipeWriter
	once sync.Once
}

func (u *uploadStream) abort() {
	u.once.Do(func() { u.pipe.CloseWithError(errors.New("upload canceled")) })
}

func (c *Client) handleFrame(ctx context.Context, frame *protocol.Frame) {
	switch frame.Kind {
	case protocol.FramePing:
		_ = c.send(&protocol.Frame{Kind: protocol.FramePong, ID: frame.ID, Ts: frame.Ts})
	case protocol.FramePong:
	case protocol.FrameHTTPRequest:
		c.handleHTTP(ctx, frame)
	case protocol.FrameWSOpen:
		c.handleWSOpen(ctx, frame)
	case protocol.FrameWSFrame:
		c.mu.Lock()
		ws := c.wsConns[frame.ID]
		c.mu.Unlock()
		if ws != nil {
			ws.inbound(frame)
		}
	case protocol.FrameWSClose:
		c.mu.Lock()
		ws := c.wsConns[frame.ID]
		c.mu.Unlock()
		if ws != nil {
			ws.remoteClose()
		}
	}
}

func (c *Client) ensureMaps() {
	if c.uploads == nil {
		c.uploads = map[string]*uploadStream{}
	}
	if c.wsConns == nil {
		c.wsConns = map[string]*clientWS{}
	}
}

func (c *Client) handleHTTP(ctx context.Context, frame *protocol.Frame) {
	if c.Handler == nil {
		return
	}
	switch frame.Phase {
	case protocol.PhaseCancel:
		c.mu.Lock()
		up := c.uploads[frame.ID]
		delete(c.uploads, frame.ID)
		c.mu.Unlock()
		if up != nil {
			up.abort()
		}
		return
	case protocol.PhaseChunk:
		c.mu.Lock()
		up := c.uploads[frame.ID]
		c.mu.Unlock()
		if up == nil {
			return
		}
		data, err := base64.StdEncoding.DecodeString(frame.ChunkBase64)
		if err != nil {
			return
		}
		_, _ = up.pipe.Write(data)
		if frame.Final {
			up.abort()
		}
		return
	}

	var body io.Reader
	if frame.BodyBase64 != "" {
		data, err := base64.StdEncoding.DecodeString(frame.BodyBase64)
		if err != nil {
			return
		}
		body = strings.NewReader(string(data))
	} else if frame.Stream {
		pr, pw := io.Pipe()
		c.mu.Lock()
		c.ensureMaps()
		c.uploads[frame.ID] = &uploadStream{pipe: pw}
		c.mu.Unlock()
		body = pr
	}
	req, err := http.NewRequestWithContext(ctx, frame.Method, frame.URL, body)
	if err != nil {
		_ = c.send(&protocol.Frame{Kind: protocol.FrameHTTPResponse, Phase: protocol.PhaseHead, ID: frame.ID, Status: 400,
			Error: &protocol.APIError{Code: protocol.CodeBadRequest, Message: "隧道请求 URL 无效"}})
		return
	}
	req.Header = http.Header(frame.Headers)
	req.RemoteAddr = "tunnel"
	rec := newFrameWriter(frame.ID, c.send)
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.uploads, frame.ID)
			c.mu.Unlock()
			rec.finish()
		}()
		c.Handler.ServeHTTP(rec, req)
	}()
}

func (c *Client) handleWSOpen(ctx context.Context, frame *protocol.Frame) {
	if c.WS == nil {
		_ = c.send(&protocol.Frame{Kind: protocol.FrameWSOpen, ID: frame.ID, Accepted: protocol.BoolPtr(false), Status: 404, Reason: "agent 未注册 ws 路由"})
		return
	}
	handler, ok := c.WS.MatchWS(frame.Path)
	if !ok {
		_ = c.send(&protocol.Frame{Kind: protocol.FrameWSOpen, ID: frame.ID, Accepted: protocol.BoolPtr(false), Status: 404, Reason: "未找到 ws 路由"})
		return
	}
	ws := newClientWS(frame.ID, c.send)
	c.mu.Lock()
	c.ensureMaps()
	c.wsConns[frame.ID] = ws
	c.mu.Unlock()
	_ = c.send(&protocol.Frame{Kind: protocol.FrameWSOpen, ID: frame.ID, Accepted: protocol.BoolPtr(true)})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, frame.Path, nil)
	if err != nil {
		return
	}
	req.Header = http.Header(frame.Headers)
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.wsConns, frame.ID)
			c.mu.Unlock()
			ws.remoteClose()
		}()
		handler(ws, req)
	}()
}

/* ------------------------------ frame writer ----------------------------- */

type frameWriter struct {
	id     string
	send   SendFunc
	mu     sync.Mutex
	status int
	header http.Header
	body   []byte
	sent   bool
	final  sync.Once
}

func newFrameWriter(id string, send SendFunc) *frameWriter {
	return &frameWriter{id: id, send: send, header: http.Header{}, status: http.StatusOK}
}

func (w *frameWriter) Header() http.Header { return w.header }

func (w *frameWriter) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.sent {
		return
	}
	w.status = status
	w.sent = true
	_ = w.send(&protocol.Frame{
		Kind: protocol.FrameHTTPResponse, Phase: protocol.PhaseHead, ID: w.id,
		Status: w.status, Headers: w.header, Stream: true,
	})
}

func (w *frameWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.sent {
		w.writeHeaderLocked()
	}
	w.body = append(w.body, p...)
	for len(w.body) >= protocol.ChunkBytes {
		chunk := w.body[:protocol.ChunkBytes]
		w.body = w.body[protocol.ChunkBytes:]
		if err := w.sendChunk(chunk, false); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func (w *frameWriter) writeHeaderLocked() {
	w.sent = true
	_ = w.send(&protocol.Frame{
		Kind: protocol.FrameHTTPResponse, Phase: protocol.PhaseHead, ID: w.id,
		Status: w.status, Headers: w.header, Stream: true,
	})
}

// Flush pushes buffered bytes to the core.
func (w *frameWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.sent {
		w.writeHeaderLocked()
	}
	if len(w.body) > 0 {
		chunk := w.body
		w.body = nil
		_ = w.sendChunk(chunk, false)
	}
}

func (w *frameWriter) finish() {
	w.final.Do(func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		if !w.sent {
			w.writeHeaderLocked()
		}
		chunk := w.body
		w.body = nil
		_ = w.sendChunk(chunk, true)
	})
}

func (w *frameWriter) sendChunk(chunk []byte, final bool) error {
	return w.send(&protocol.Frame{
		Kind:        protocol.FrameHTTPResponse,
		Phase:       protocol.PhaseChunk,
		ID:          w.id,
		ChunkBase64: base64.StdEncoding.EncodeToString(chunk),
		Final:       final,
	})
}

/* ------------------------------- client WS ------------------------------- */

type clientWS struct {
	id     string
	send   SendFunc
	in     chan wsMessage
	closed chan struct{}
	once   sync.Once
}

func newClientWS(id string, send SendFunc) *clientWS {
	return &clientWS{id: id, send: send, in: make(chan wsMessage, 32), closed: make(chan struct{})}
}

func (w *clientWS) inbound(frame *protocol.Frame) {
	var data []byte
	var err error
	kind := websocket.TextMessage
	if frame.DataEncoding == "base64" {
		data, err = base64.StdEncoding.DecodeString(frame.Data)
		kind = websocket.BinaryMessage
	} else {
		data = []byte(frame.Data)
	}
	if err != nil {
		return
	}
	select {
	case w.in <- wsMessage{kind: kind, data: data}:
	case <-w.closed:
	}
}

func (w *clientWS) remoteClose() {
	w.once.Do(func() { close(w.closed) })
}

func (w *clientWS) ReadMessage() (int, []byte, error) {
	select {
	case msg, ok := <-w.in:
		if !ok {
			return 0, nil, io.EOF
		}
		return msg.kind, msg.data, nil
	case <-w.closed:
		return 0, nil, io.EOF
	}
}

func (w *clientWS) WriteMessage(kind int, data []byte) error {
	frame := &protocol.Frame{Kind: protocol.FrameWSFrame, ID: w.id}
	if kind == websocket.BinaryMessage {
		frame.Data = base64.StdEncoding.EncodeToString(data)
		frame.DataEncoding = "base64"
	} else {
		frame.Data = string(data)
		frame.DataEncoding = "utf8"
	}
	return w.send(frame)
}

func (w *clientWS) Close() error {
	w.remoteClose()
	return w.send(&protocol.Frame{Kind: protocol.FrameWSClose, ID: w.id, Code: 1000, Initiator: "worker"})
}

/* --------------------------------- utils --------------------------------- */

func limitsPtr(l protocol.ProtocolLimits) *protocol.ProtocolLimits { return &l }

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func nextBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > 30*time.Second {
		next = 30 * time.Second
	}
	return next
}

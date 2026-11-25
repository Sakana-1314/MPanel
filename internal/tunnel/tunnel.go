// Package tunnel multiplexes HTTP requests and WebSocket streams over a single
// byte stream: NDJSON on stdio, or one WebSocket message per frame. The core
// side (Server) talks to one agent per session; the agent side (Client) dials
// the core and serves frames through its local http.Handler.
package tunnel

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

// WSHandler serves one tunneled WebSocket stream.
type WSHandler func(protocol.WSConn, *http.Request)

// WSMatcher resolves a path to a registered WebSocket handler.
type WSMatcher interface {
	MatchWS(path string) (WSHandler, bool)
}

// SendFunc writes one encoded frame.
type SendFunc func(*protocol.Frame) error

/* ------------------------------- server side ----------------------------- */

type pendingResponse struct {
	head   chan *protocol.Frame
	chunks chan *protocol.Frame
	once   sync.Once
}

func newPendingResponse() *pendingResponse {
	return &pendingResponse{head: make(chan *protocol.Frame, 1), chunks: make(chan *protocol.Frame, 32)}
}

func (p *pendingResponse) finish() {
	p.once.Do(func() { close(p.chunks) })
}

// Session is one live tunnel to an agent.
type Session struct {
	MachineID string
	Kind      string // "stdio" | "reverse-ws"

	send   SendFunc
	log    *slog.Logger
	closed chan struct{}
	once   sync.Once
	seen   time.Time

	mu      sync.Mutex
	pending map[string]*pendingResponse
	wsConns map[string]*frameWS
}

// newSession wires a session over a frame writer.
func newSession(machineID, kind string, send SendFunc, log *slog.Logger) *Session {
	return &Session{
		MachineID: machineID,
		Kind:      kind,
		send:      send,
		log:       log,
		closed:    make(chan struct{}),
		seen:      time.Now(),
		pending:   map[string]*pendingResponse{},
		wsConns:   map[string]*frameWS{},
	}
}

// Closed is closed when the session ends.
func (s *Session) Closed() <-chan struct{} { return s.closed }

// LastSeen reports the last inbound frame time.
func (s *Session) LastSeen() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seen
}

func (s *Session) close() {
	s.once.Do(func() {
		close(s.closed)
		s.mu.Lock()
		for _, p := range s.pending {
			p.finish()
		}
		for _, ws := range s.wsConns {
			ws.remoteClose()
		}
		s.pending = map[string]*pendingResponse{}
		s.wsConns = map[string]*frameWS{}
		s.mu.Unlock()
	})
}

// dispatch handles one inbound frame.
func (s *Session) dispatch(frame *protocol.Frame) {
	s.mu.Lock()
	s.seen = time.Now()
	s.mu.Unlock()

	switch frame.Kind {
	case protocol.FramePing:
		_ = s.send(&protocol.Frame{Kind: protocol.FramePong, ID: frame.ID, Ts: frame.Ts})
	case protocol.FramePong:
		// heartbeat bookkeeping is the last-seen timestamp above
	case protocol.FrameHTTPResponse:
		s.mu.Lock()
		p := s.pending[frame.ID]
		s.mu.Unlock()
		if p == nil {
			return
		}
		switch frame.Phase {
		case protocol.PhaseChunk:
			select {
			case p.chunks <- frame:
			case <-s.closed:
			}
			if frame.Final {
				p.finish()
			}
		default:
			select {
			case p.head <- frame:
			default:
			}
			if frame.BodyBase64 == "" && !frame.Stream {
				p.finish()
			}
			if frame.Error != nil {
				p.finish()
			}
		}
	case protocol.FrameWSOpen:
		if frame.Accepted == nil {
			return
		}
		s.mu.Lock()
		ws := s.wsConns[frame.ID]
		s.mu.Unlock()
		if ws != nil {
			ws.openReply(frame)
		}
	case protocol.FrameWSFrame:
		s.mu.Lock()
		ws := s.wsConns[frame.ID]
		s.mu.Unlock()
		if ws != nil {
			ws.inbound(frame)
		}
	case protocol.FrameWSClose:
		s.mu.Lock()
		ws := s.wsConns[frame.ID]
		s.mu.Unlock()
		if ws != nil {
			ws.remoteClose()
		}
	}
}

// Do performs one request over the tunnel and returns a streaming response.
func (s *Session) Do(ctx context.Context, method, path string, header http.Header, body []byte) (*http.Response, error) {
	select {
	case <-s.closed:
		return nil, protocol.Upstream("agent 连接已断开")
	default:
	}

	id := "r_" + protocol.RandomID(9)
	pend := newPendingResponse()
	s.mu.Lock()
	s.pending[id] = pend
	s.mu.Unlock()
	// The pending entry lives until the response stream ends: buildResponse
	// owns the cleanup for the streaming path, and every early return drops it.
	drop := func() {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
	}

	head := &protocol.Frame{
		Kind:    protocol.FrameHTTPRequest,
		Phase:   protocol.PhaseHead,
		ID:      id,
		Method:  method,
		URL:     path,
		Headers: header,
		Stream:  true,
	}
	if len(body) <= protocol.ChunkBytes {
		head.BodyBase64 = base64.StdEncoding.EncodeToString(body)
	}
	if err := s.send(head); err != nil {
		drop()
		return nil, protocol.Upstream("发送隧道请求失败: " + err.Error())
	}
	if len(body) > protocol.ChunkBytes {
		go s.sendChunks(id, body)
	}

	select {
	case respHead := <-pend.head:
		return s.buildResponse(ctx, id, pend, respHead, drop)
	case <-ctx.Done():
		drop()
		_ = s.send(&protocol.Frame{Kind: protocol.FrameHTTPRequest, Phase: protocol.PhaseCancel, ID: id, Reason: "client canceled"})
		return nil, ctx.Err()
	case <-s.closed:
		drop()
		return nil, protocol.Upstream("agent 连接已断开")
	}
}

func (s *Session) sendChunks(id string, body []byte) {
	for offset := 0; offset < len(body); offset += protocol.ChunkBytes {
		end := offset + protocol.ChunkBytes
		if end > len(body) {
			end = len(body)
		}
		frame := &protocol.Frame{
			Kind:        protocol.FrameHTTPRequest,
			Phase:       protocol.PhaseChunk,
			ID:          id,
			ChunkBase64: base64.StdEncoding.EncodeToString(body[offset:end]),
			Final:       end == len(body),
		}
		if err := s.send(frame); err != nil {
			return
		}
	}
}

func (s *Session) buildResponse(ctx context.Context, id string, pend *pendingResponse, head *protocol.Frame, drop func()) (*http.Response, error) {
	if head.Error != nil {
		drop()
		return nil, &protocol.PanelError{Code: head.Error.Code, Message: head.Error.Message, Details: head.Error.Details}
	}
	header := http.Header(head.Headers)
	resp := &http.Response{
		StatusCode: head.Status,
		Status:     strconv.Itoa(head.Status) + " " + http.StatusText(head.Status),
		Header:     header,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
	}
	if head.BodyBase64 != "" && !head.Stream {
		data, err := base64.StdEncoding.DecodeString(head.BodyBase64)
		drop()
		if err != nil {
			return nil, protocol.Upstream("隧道响应 base64 无效")
		}
		resp.Body = io.NopCloser(strings.NewReader(string(data)))
		return resp, nil
	}
	pr, pw := io.Pipe()
	resp.Body = pr
	go func() {
		defer drop()
		defer pw.Close()
		for {
			select {
			case frame, ok := <-pend.chunks:
				if !ok {
					return
				}
				data, err := base64.StdEncoding.DecodeString(frame.ChunkBase64)
				if err != nil {
					pw.CloseWithError(protocol.Upstream("隧道响应分块无效"))
					return
				}
				if _, err := pw.Write(data); err != nil {
					return
				}
				if frame.Final {
					return
				}
			case <-ctx.Done():
				pw.CloseWithError(ctx.Err())
				return
			case <-s.closed:
				pw.CloseWithError(protocol.Upstream("agent 连接已断开"))
				return
			}
		}
	}()
	return resp, nil
}

// OpenWS opens a multiplexed WebSocket stream to the agent.
func (s *Session) OpenWS(ctx context.Context, path string, header http.Header) (protocol.WSConn, error) {
	id := "ws_" + protocol.RandomID(9)
	ws := newFrameWS(id, s)
	s.mu.Lock()
	s.wsConns[id] = ws
	s.mu.Unlock()
	frame := &protocol.Frame{Kind: protocol.FrameWSOpen, ID: id, Path: path, Headers: header}
	if err := s.send(frame); err != nil {
		s.mu.Lock()
		delete(s.wsConns, id)
		s.mu.Unlock()
		return nil, protocol.Upstream("发送 ws-open 失败")
	}
	select {
	case reply := <-ws.openCh:
		if reply.Accepted == nil || !*reply.Accepted {
			s.mu.Lock()
			delete(s.wsConns, id)
			s.mu.Unlock()
			status := 404
			if reply.Status != 0 {
				status = reply.Status
			}
			if status >= 500 {
				return nil, protocol.Unavailable("agent 无法建立 WebSocket", reply.Reason)
			}
			return nil, protocol.Upstream("agent 拒绝 WebSocket: " + reply.Reason)
		}
		ws.markOpen()
		return ws, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.closed:
		return nil, protocol.Upstream("agent 连接已断开")
	}
}

// ServeWebSocket runs the read loop over a core<->agent websocket.
func (s *Server) ServeWebSocket(ctx context.Context, machineID, kind string, conn *websocket.Conn) (*Session, error) {
	var writeMu sync.Mutex
	send := func(frame *protocol.Frame) error {
		data, err := protocol.EncodeFrame(frame)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return conn.WriteMessage(websocket.TextMessage, data)
	}
	session := newSession(machineID, kind, send, s.log)
	s.register(machineID, session)
	go func() {
		defer func() {
			session.close()
			s.unregister(machineID, session)
			_ = conn.Close()
		}()
		for {
			_ = conn.SetReadDeadline(time.Now().Add(protocol.HeartbeatTimeoutSec * time.Second))
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			frame, err := protocol.DecodeFrame(data)
			if err != nil {
				continue
			}
			session.dispatch(frame)
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
	go s.heartbeat(ctx, session)
	return session, nil
}

// ServeStream runs the read loop over a bidirectional byte stream (stdio).
func (s *Server) ServeStream(ctx context.Context, machineID string, r io.Reader, w io.Writer) (*Session, error) {
	var writeMu sync.Mutex
	send := func(frame *protocol.Frame) error {
		data, err := protocol.EncodeFrame(frame)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_, err = w.Write(append(data, '\n'))
		return err
	}
	session := newSession(machineID, "stdio", send, s.log)
	s.register(machineID, session)
	go func() {
		defer func() {
			session.close()
			s.unregister(machineID, session)
		}()
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 64*1024), protocol.MaxFrameBytes+1024)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			frame, err := protocol.DecodeFrame(line)
			if err != nil {
				continue
			}
			session.dispatch(frame)
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
	go s.heartbeat(ctx, session)
	return session, nil
}

func (s *Server) heartbeat(ctx context.Context, session *Session) {
	ticker := time.NewTicker(protocol.HeartbeatIntervalSec * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-session.Closed():
			return
		case now := <-ticker.C:
			if now.Sub(session.LastSeen()) > protocol.HeartbeatTimeoutSec*time.Second {
				session.close()
				return
			}
			_ = session.send(&protocol.Frame{Kind: protocol.FramePing, ID: "hb", Ts: now.UnixMilli()})
		}
	}
}

// Server tracks live sessions by machine id.
type Server struct {
	log     *slog.Logger
	mu      sync.Mutex
	session map[string]*Session
}

// NewServer creates the core-side registry.
func NewServer(log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{log: log, session: map[string]*Session{}}
}

func (s *Server) register(machineID string, session *Session) {
	s.mu.Lock()
	old := s.session[machineID]
	s.session[machineID] = session
	s.mu.Unlock()
	if old != nil {
		old.close()
	}
}

func (s *Server) unregister(machineID string, session *Session) {
	s.mu.Lock()
	if s.session[machineID] == session {
		delete(s.session, machineID)
	}
	s.mu.Unlock()
}

// Get returns the live session for a machine.
func (s *Server) Get(machineID string) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.session[machineID]
}

// Online reports whether a machine has a live tunnel.
func (s *Server) Online(machineID string) bool { return s.Get(machineID) != nil }

/* ------------------------------ websocket stream -------------------------- */

type wsMessage struct {
	kind int
	data []byte
}

type frameWS struct {
	id     string
	sess   *Session
	openCh chan *protocol.Frame
	in     chan wsMessage
	closed chan struct{}
	once   sync.Once
	ready  bool
}

func newFrameWS(id string, sess *Session) *frameWS {
	return &frameWS{
		id:     id,
		sess:   sess,
		openCh: make(chan *protocol.Frame, 1),
		in:     make(chan wsMessage, 32),
		closed: make(chan struct{}),
	}
}

func (w *frameWS) markOpen() { w.ready = true }

func (w *frameWS) openReply(frame *protocol.Frame) {
	select {
	case w.openCh <- frame:
	default:
	}
}

func (w *frameWS) inbound(frame *protocol.Frame) {
	var data []byte
	var err error
	if frame.DataEncoding == "base64" {
		data, err = base64.StdEncoding.DecodeString(frame.Data)
	} else {
		data = []byte(frame.Data)
	}
	if err != nil {
		return
	}
	kind := websocket.TextMessage
	if frame.DataEncoding == "base64" {
		kind = websocket.BinaryMessage
	}
	select {
	case w.in <- wsMessage{kind: kind, data: data}:
	case <-w.closed:
	}
}

func (w *frameWS) remoteClose() {
	w.once.Do(func() { close(w.closed) })
}

// ReadMessage implements protocol.WSConn.
func (w *frameWS) ReadMessage() (int, []byte, error) {
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

// WriteMessage implements protocol.WSConn.
func (w *frameWS) WriteMessage(kind int, data []byte) error {
	frame := &protocol.Frame{Kind: protocol.FrameWSFrame, ID: w.id}
	if kind == websocket.BinaryMessage {
		frame.Data = base64.StdEncoding.EncodeToString(data)
		frame.DataEncoding = "base64"
	} else {
		frame.Data = string(data)
		frame.DataEncoding = "utf8"
	}
	if len(data) > protocol.MaxWSMessageBytes {
		return errors.New("ws 消息超过上限")
	}
	return w.sess.send(frame)
}

// Close implements protocol.WSConn.
func (w *frameWS) Close() error {
	w.remoteClose()
	w.sess.mu.Lock()
	delete(w.sess.wsConns, w.id)
	w.sess.mu.Unlock()
	return w.sess.send(&protocol.Frame{Kind: protocol.FrameWSClose, ID: w.id, Code: 1000, Initiator: "core"})
}

// SelfClose closes the session from the core side (disconnect/rotate/delete).
func (s *Session) SelfClose() { s.close() }

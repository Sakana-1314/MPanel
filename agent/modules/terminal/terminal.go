// Package terminal implements interactive shell sessions: a PTY on Unix, a
// pipe-backed fallback on Windows, session lifecycle HTTP APIs, and the
// /ws/terminal/{id} bridge used by the panel's xterm view.
package terminal

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/core/httpapi"
	"github.com/sakana-1314/mpanel/core/protocol"
)

const (
	maxSessions    = 20
	idleTimeout    = 30 * time.Minute
	outputRingSize = 200 * 1024
	maxInputBytes  = 1 << 20
	bridgeQueue    = 128
	defaultCols    = 80
	defaultRows    = 24
	minCols        = 2
	minRows        = 1
	maxDimension   = 1000
)

// deniedEnv are panel credentials that must never reach a session, even when
// the agent itself was started with them in its environment.
var deniedEnv = []string{
	"MPANEL_TOKEN",
	"MPANEL_SECRET_KEY",
	"MPANEL_CORE_TOKEN",
	"MPANEL_MACHINE_SECRET",
}

// Session status values mirror the API contract.
const (
	statusRunning = "running"
	statusExited  = "exited"
)

// SessionInfo is the wire shape of a terminal session (contract §11).
type SessionInfo struct {
	ID             string `json:"id"`
	Shell          string `json:"shell"`
	Cwd            string `json:"cwd"`
	Cols           int    `json:"cols"`
	Rows           int    `json:"rows"`
	PTY            bool   `json:"pty"`
	Status         string `json:"status"`
	ExitCode       *int   `json:"exitCode"`
	CreatedAt      string `json:"createdAt"`
	LastActivityAt string `json:"lastActivityAt"`
}

// ShellInfo is one entry of GET /terminal/shells.
type ShellInfo struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// Module implements the terminal feature module.
type Module struct {
	mu       sync.Mutex
	ctx      *agent.Context
	sessions map[string]*session
}

// New returns the terminal module.
func New() *Module {
	return &Module{sessions: make(map[string]*session)}
}

// Name implements agent.Module.
func (m *Module) Name() string { return "terminal" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	if ctx == nil || ctx.Mux == nil {
		return errors.New("terminal: 缺少 HTTP mux")
	}
	m.mu.Lock()
	m.ctx = ctx
	m.mu.Unlock()

	ctx.Mux.HandleFunc("GET /api/v1/terminal/shells", m.handleShells)
	ctx.Mux.HandleFunc("GET /api/v1/terminal/sessions", m.handleList)
	ctx.Mux.HandleFunc("POST /api/v1/terminal/sessions", m.handleCreate)
	ctx.Mux.HandleFunc("GET /api/v1/terminal/sessions/{id}", m.handleGet)
	ctx.Mux.HandleFunc("DELETE /api/v1/terminal/sessions/{id}", m.handleDelete)
	if ctx.WS != nil {
		ctx.WS.Handle("/ws/terminal/", m.handleWS)
	}
	go m.reapLoop()
	return nil
}

func (m *Module) context() *agent.Context {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ctx
}

/* --------------------------------- HTTP --------------------------------- */

func (m *Module) handleShells(w http.ResponseWriter, _ *http.Request) {
	shells := discoverShells()
	if len(shells) == 0 {
		httpapi.OK(w, protocol.UnavailableList[ShellInfo]("未找到可用的 shell"))
		return
	}
	httpapi.OK(w, protocol.NewList(shells))
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	all := m.listSessions()
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, next, total := protocol.Page(all, limit, r.URL.Query().Get("cursor"))
	httpapi.OK(w, protocol.ListResult[SessionInfo]{
		Available:  true,
		Items:      items,
		NextCursor: next,
		Total:      &total,
	})
}

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	var input createInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	sess, err := m.createSession(input)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.Created(w, sess.info())
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if sess := m.lookup(id); sess != nil {
		httpapi.OK(w, sess.info())
		return
	}
	httpapi.Fail(w, protocol.NotFound("终端会话", id))
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if m.closeSession(id) {
		httpapi.OK(w, map[string]any{"closed": true, "id": id})
		return
	}
	httpapi.Fail(w, protocol.NotFound("终端会话", id))
}

func (m *Module) listSessions() []SessionInfo {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, sess := range m.sessions {
		all = append(all, sess)
	}
	m.mu.Unlock()
	out := make([]SessionInfo, 0, len(all))
	for _, sess := range all {
		out = append(out, sess.info())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt == out[j].CreatedAt {
			return out[i].ID > out[j].ID
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

func (m *Module) lookup(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *Module) closeSession(id string) bool {
	m.mu.Lock()
	sess := m.sessions[id]
	if sess != nil {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if sess == nil {
		return false
	}
	sess.shutdown()
	return true
}

/* ------------------------------- Sessions ------------------------------- */

type createInput struct {
	Shell string            `json:"shell"`
	Cwd   string            `json:"cwd"`
	Cols  int               `json:"cols"`
	Rows  int               `json:"rows"`
	Env   map[string]string `json:"env"`
}

type session struct {
	id      string
	shell   string
	cwd     string
	pty     bool
	created time.Time

	mu           sync.Mutex
	cols         int
	rows         int
	status       string
	exitCode     *int
	signal       string
	lastActivity time.Time
	proc         *process
	ring         *ringBuffer
	bridges      map[*bridge]struct{}
	done         chan struct{}

	finishOnce sync.Once
}

func (m *Module) createSession(input createInput) (*session, error) {
	ctx := m.context()
	if ctx == nil || ctx.Cfg == nil {
		return nil, protocol.Unavailable("终端模块尚未就绪", "请稍后重试")
	}
	shellPath, err := resolveShell(input.Shell)
	if err != nil {
		return nil, err
	}
	cwd, err := resolveCwd(ctx, input.Cwd)
	if err != nil {
		return nil, err
	}
	env, err := buildEnv(input.Env)
	if err != nil {
		return nil, err
	}
	cols, rows := normalizeSize(input.Cols, input.Rows)

	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessions) >= maxSessions {
		return nil, protocol.Conflict("终端会话数量已达上限（20）")
	}
	proc, err := startProcess(processSpec{shell: shellPath, cwd: cwd, env: env, cols: uint16(cols), rows: uint16(rows)})
	if err != nil {
		return nil, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "无法启动终端 shell",
			Details: map[string]any{"error": err.Error()},
		}
	}
	now := time.Now()
	sess := &session{
		id:           "term_" + protocol.RandomID(9),
		shell:        shellPath,
		cwd:          cwd,
		pty:          proc.IsPTY(),
		created:      now,
		cols:         cols,
		rows:         rows,
		status:       statusRunning,
		lastActivity: now,
		proc:         proc,
		ring:         newRingBuffer(outputRingSize),
		bridges:      make(map[*bridge]struct{}),
		done:         make(chan struct{}),
	}
	m.sessions[sess.id] = sess
	go sess.waitLoop()
	go sess.pump()
	return sess, nil
}

func (s *session) info() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	var code *int
	if s.exitCode != nil {
		v := *s.exitCode
		code = &v
	}
	return SessionInfo{
		ID:             s.id,
		Shell:          s.shell,
		Cwd:            s.cwd,
		Cols:           s.cols,
		Rows:           s.rows,
		PTY:            s.pty,
		Status:         s.status,
		ExitCode:       code,
		CreatedAt:      s.created.UTC().Format(time.RFC3339),
		LastActivityAt: s.lastActivity.UTC().Format(time.RFC3339),
	}
}

func (s *session) pump() {
	buf := make([]byte, 32*1024)
	var carry []byte
	for {
		n, err := s.proc.Read(buf)
		if n > 0 {
			data := append(append([]byte(nil), carry...), buf[:n]...)
			complete, rest := splitCompleteUTF8(data)
			carry = append([]byte(nil), rest...)
			if len(complete) > 0 {
				s.emit(complete)
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *session) waitLoop() {
	code, signal, _ := s.proc.Wait()
	s.finish(code, signal)
}

func (s *session) emit(data []byte) {
	s.mu.Lock()
	if s.status == statusExited {
		s.mu.Unlock()
		return
	}
	s.lastActivity = time.Now()
	s.ring.Write(data)
	frame, err := json.Marshal(wsOutputMessage{Type: "output", Data: string(data)})
	if err != nil {
		s.mu.Unlock()
		return
	}
	var slow []*bridge
	for b := range s.bridges {
		if !b.enqueue(frame) {
			delete(s.bridges, b)
			slow = append(slow, b)
		}
	}
	s.mu.Unlock()
	for _, b := range slow {
		b.shutdown(protocol.WSCloseTryAgainLater)
	}
}

func (s *session) finish(code *int, signal string) {
	s.finishOnce.Do(func() {
		s.mu.Lock()
		s.status = statusExited
		s.exitCode = code
		s.signal = signal
		s.lastActivity = time.Now()
		bridgeList := make([]*bridge, 0, len(s.bridges))
		for b := range s.bridges {
			bridgeList = append(bridgeList, b)
		}
		s.bridges = make(map[*bridge]struct{})
		frame, _ := json.Marshal(wsExitMessage{Type: "exit", Code: code, Signal: signal})
		for _, b := range bridgeList {
			b.enqueue(frame)
		}
		close(s.done)
		s.mu.Unlock()
		for _, b := range bridgeList {
			b.shutdown(protocol.WSCloseNormal)
		}
	})
}

func (s *session) shutdown() {
	_ = s.proc.Kill()
	select {
	case <-s.done:
	case <-time.After(2 * time.Second):
		// A wedged child must not keep DELETE hanging; mark the session exited
		// and let the process be reaped in the background.
		s.finish(nil, "killed")
	}
	_ = s.proc.Close()
}

func (s *session) idleFor() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Since(s.lastActivity)
}

func (s *session) writeInput(data []byte) error {
	s.mu.Lock()
	if s.status == statusExited {
		s.mu.Unlock()
		return io.ErrClosedPipe
	}
	s.lastActivity = time.Now()
	proc := s.proc
	s.mu.Unlock()
	_, err := proc.Write(data)
	return err
}

func (s *session) resize(cols, rows int) {
	cols, rows = clampSize(cols, rows)
	s.mu.Lock()
	s.cols = cols
	s.rows = rows
	s.lastActivity = time.Now()
	proc := s.proc
	pty := s.pty
	s.mu.Unlock()
	if pty {
		_ = proc.Resize(uint16(cols), uint16(rows))
	}
}

func (s *session) exitFrame() wsExitMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return wsExitMessage{Type: "exit", Code: s.exitCode, Signal: s.signal}
}

type bridge struct {
	mu        sync.Mutex
	closed    bool
	closeCode int
	out       chan []byte
	stop      chan struct{}
	once      sync.Once
}

func newBridge() *bridge {
	return &bridge{out: make(chan []byte, bridgeQueue), stop: make(chan struct{})}
}

func (b *bridge) enqueue(msg []byte) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return false
	}
	select {
	case b.out <- msg:
		return true
	default:
		return false
	}
}

func (b *bridge) shutdown(code int) {
	b.once.Do(func() {
		b.mu.Lock()
		b.closed = true
		b.closeCode = code
		b.mu.Unlock()
		close(b.stop)
	})
}

func (b *bridge) code() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closeCode
}

// attach registers a WS bridge. It returns false when the session already
// exited; the caller still gets the session state so it can send ready+exit.
func (s *session) attach() (*bridge, bool) {
	b := newBridge()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == statusExited {
		return b, false
	}
	s.bridges[b] = struct{}{}
	s.lastActivity = time.Now()
	return b, true
}

func (s *session) detach(b *bridge) {
	s.mu.Lock()
	delete(s.bridges, b)
	s.mu.Unlock()
}

func (m *Module) reapLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		m.mu.Lock()
		var stale []*session
		for id, sess := range m.sessions {
			if sess.idleFor() >= idleTimeout {
				delete(m.sessions, id)
				stale = append(stale, sess)
			}
		}
		m.mu.Unlock()
		for _, sess := range stale {
			sess.shutdown()
		}
	}
}

/* --------------------------------- WS ---------------------------------- */

type wsClientMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type wsReadyMessage struct {
	Type    string      `json:"type"`
	Session SessionInfo `json:"session"`
}

type wsOutputMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

type wsExitMessage struct {
	Type   string `json:"type"`
	Code   *int   `json:"code"`
	Signal string `json:"signal,omitempty"`
}

type wsErrorMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type wsPongMessage struct {
	Type string `json:"type"`
}

func (m *Module) handleWS(conn protocol.WSConn, r *http.Request) {
	if conn == nil {
		return
	}
	id, err := sessionIDFromPath(r.URL.Path)
	if err != nil {
		closeWS(conn, protocol.WSCloseNotFound, "会话不存在")
		return
	}
	sess := m.lookup(id)
	if sess == nil {
		closeWS(conn, protocol.WSCloseNotFound, "会话不存在")
		return
	}
	br, running := sess.attach()
	defer func() {
		sess.detach(br)
		br.shutdown(0)
		_ = conn.Close()
	}()

	if err := writeJSON(conn, wsReadyMessage{Type: "ready", Session: sess.info()}); err != nil {
		return
	}
	if !running {
		_ = writeJSON(conn, sess.exitFrame())
		closeWS(conn, protocol.WSCloseNormal, "")
		return
	}

	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer func() {
			if code := br.code(); code != 0 {
				closeWS(conn, code, "")
				return
			}
			_ = conn.Close()
		}()
		for {
			select {
			case msg := <-br.out:
				if err := conn.WriteMessage(protocol.TextMessage, msg); err != nil {
					return
				}
			case <-br.stop:
				// Drain the winning exit frame (if any) before closing.
				for {
					select {
					case msg := <-br.out:
						if err := conn.WriteMessage(protocol.TextMessage, msg); err != nil {
							return
						}
					default:
						return
					}
				}
			}
		}
	}()

	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if kind != protocol.TextMessage {
			closeWS(conn, protocol.WSCloseUnsupportedData, "仅支持文本帧")
			break
		}
		if len(data) > maxInputBytes {
			closeWS(conn, protocol.WSCloseTryAgainLater, "帧超过 1 MiB")
			break
		}
		var msg wsClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			br.enqueue(mustJSON(wsErrorMessage{Type: "error", Code: string(protocol.CodeBadRequest), Message: "无法解析终端消息"}))
			continue
		}
		switch msg.Type {
		case "input":
			if msg.Data == "" {
				continue
			}
			if err := sess.writeInput([]byte(msg.Data)); err != nil {
				br.enqueue(mustJSON(wsErrorMessage{Type: "error", Code: string(protocol.CodeUnavailable), Message: "会话已结束"}))
			}
		case "resize":
			sess.resize(msg.Cols, msg.Rows)
		case "ping":
			if !br.enqueue(mustJSON(wsPongMessage{Type: "pong"})) {
				closeWS(conn, protocol.WSCloseTryAgainLater, "输出背压")
				break
			}
		}
	}
	br.shutdown(0)
	select {
	case <-writerDone:
	case <-time.After(time.Second):
	}
}

func sessionIDFromPath(path string) (string, error) {
	const prefix = "/ws/terminal/"
	if !strings.HasPrefix(path, prefix) {
		return "", errors.New("not a terminal path")
	}
	raw := strings.TrimSuffix(strings.TrimPrefix(path, prefix), "/")
	if raw == "" || strings.Contains(raw, "/") {
		return "", errors.New("empty session id")
	}
	id, err := url.PathUnescape(raw)
	if err != nil || id == "" {
		return "", errors.New("bad session id")
	}
	return id, nil
}

func writeJSON(conn protocol.WSConn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return conn.WriteMessage(protocol.TextMessage, data)
}

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

// closeConnWriter is implemented by gorilla connections. Tunneled WS wrappers
// only expose WriteMessage/Close, so a close code cannot be forwarded through
// them; those connections are closed without an application close reason.
type closeConnWriter interface {
	WriteControl(messageType int, data []byte, deadline time.Time) error
}

func closeWS(conn protocol.WSConn, code int, reason string) {
	if wc, ok := conn.(closeConnWriter); ok {
		_ = wc.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
	}
	_ = conn.Close()
}

/* ------------------------------- Helpers -------------------------------- */

func normalizeSize(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = defaultCols
	}
	if rows <= 0 {
		rows = defaultRows
	}
	return clampSize(cols, rows)
}

func clampSize(cols, rows int) (int, int) {
	if cols < minCols {
		cols = minCols
	}
	if rows < minRows {
		rows = minRows
	}
	if cols > maxDimension {
		cols = maxDimension
	}
	if rows > maxDimension {
		rows = maxDimension
	}
	return cols, rows
}

// splitCompleteUTF8 keeps an incomplete multi-byte rune for the next read so
// JSON output never truncates a character in the middle.
func splitCompleteUTF8(data []byte) ([]byte, []byte) {
	if len(data) == 0 || utf8.Valid(data) {
		return data, nil
	}
	limit := utf8.UTFMax
	if len(data) < limit {
		limit = len(data)
	}
	for cut := 1; cut <= limit; cut++ {
		prefix := data[:len(data)-cut]
		if utf8.Valid(prefix) {
			return prefix, data[len(data)-cut:]
		}
	}
	return data, nil
}

func buildEnv(extra map[string]string) ([]string, error) {
	values := make(map[string]string, len(os.Environ())+len(extra))
	for _, entry := range os.Environ() {
		if idx := strings.IndexByte(entry, '='); idx > 0 {
			values[entry[:idx]] = entry[idx+1:]
		}
	}
	for key, value := range extra {
		if key == "" || strings.ContainsAny(key, "=\x00") {
			return nil, protocol.BadRequest("环境变量名不合法: " + key)
		}
		if strings.ContainsRune(value, '\x00') {
			return nil, protocol.BadRequest("环境变量值包含非法字符: " + key)
		}
		values[key] = value
	}
	for _, key := range deniedEnv {
		delete(values, key)
	}
	if values["TERM"] == "" {
		values["TERM"] = "xterm-256color"
	}
	out := make([]string, 0, len(values))
	for key, value := range values {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out, nil
}

func resolveShell(requested string) (string, error) {
	if strings.TrimSpace(requested) != "" {
		path, err := checkShell(requested)
		if err != nil {
			return "", &protocol.PanelError{
				Code:    protocol.CodeBadRequest,
				Message: "shell 不存在或不可执行: " + requested,
				Details: map[string]any{"error": err.Error()},
			}
		}
		return path, nil
	}
	for _, candidate := range defaultShellCandidates() {
		if path, err := checkShell(candidate); err == nil {
			return path, nil
		}
	}
	return "", &protocol.PanelError{
		Code:    protocol.CodeUnavailable,
		Message: "未找到可用的 shell",
		Hint:    "请安装 bash/sh，或通过创建会话的 shell 字段指定绝对路径。",
	}
}

func checkShell(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("empty shell")
	}
	path := name
	if runtime.GOOS == "windows" || !strings.ContainsAny(name, `/\`) {
		if resolved, err := exec.LookPath(name); err == nil {
			path = resolved
		} else if runtime.GOOS == "windows" || !strings.ContainsAny(name, `/\`) {
			return "", err
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", errors.New("shell 是目录")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", errors.New("shell 不可执行")
	}
	return filepath.Clean(path), nil
}

func defaultShellCandidates() []string {
	if runtime.GOOS == "windows" {
		return []string{"powershell.exe", "pwsh.exe", "cmd.exe", os.Getenv("COMSPEC")}
	}
	return []string{os.Getenv("SHELL"), "/bin/bash", "/bin/sh", "/usr/bin/bash", "/bin/zsh", "sh"}
}

func discoverShells() []ShellInfo {
	seen := make(map[string]struct{})
	out := make([]ShellInfo, 0, 8)
	if runtime.GOOS == "windows" {
		for _, name := range defaultShellCandidates() {
			path, err := checkShell(name)
			if err != nil {
				continue
			}
			if _, ok := seen[path]; ok {
				continue
			}
			seen[path] = struct{}{}
			out = append(out, ShellInfo{Path: path, Name: filepath.Base(path)})
		}
		return out
	}
	candidates := defaultShellCandidates()
	candidates = append(candidates, "/usr/bin/zsh", "/usr/bin/fish", "/bin/ksh", "/usr/local/bin/bash")
	for _, name := range candidates {
		path, err := checkShell(name)
		if err != nil {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		out = append(out, ShellInfo{Path: path, Name: filepath.Base(path)})
	}
	return out
}

func resolveCwd(ctx *agent.Context, requested string) (string, error) {
	raw := strings.TrimSpace(requested)
	if raw == "" {
		raw = ctx.Cfg.Agent.BaseDir
	}
	if raw == "" {
		raw = ctx.DataDir()
	}
	if raw == "" {
		raw = "."
	}
	absolute, err := filepath.Abs(raw)
	if err != nil {
		return "", protocol.BadRequest("工作目录不合法: " + raw)
	}
	real, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", protocol.BadRequest("工作目录不存在: " + raw)
	}
	info, err := os.Stat(real)
	if err != nil || !info.IsDir() {
		return "", protocol.BadRequest("工作目录不是目录: " + raw)
	}
	if !allowedCwd(ctx, real) {
		return "", &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "工作目录不在允许范围内",
			Details: map[string]any{"cwd": real},
		}
	}
	return real, nil
}

func allowedCwd(ctx *agent.Context, target string) bool {
	roots := make([]string, 0, len(ctx.Cfg.Agent.FilesRoots)+3)
	roots = append(roots, ctx.Cfg.Agent.BaseDir, ctx.DataDir())
	for _, root := range ctx.Cfg.Agent.FilesRoots {
		roots = append(roots, root.Path)
	}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, home)
	}
	for _, root := range roots {
		if strings.TrimSpace(root) == "" {
			continue
		}
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(rootAbs); err == nil {
			rootAbs = resolved
		}
		if pathWithin(rootAbs, target) {
			return true
		}
	}
	return false
}

func pathWithin(root, target string) bool {
	if runtime.GOOS == "windows" {
		root = strings.ToLower(root)
		target = strings.ToLower(target)
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

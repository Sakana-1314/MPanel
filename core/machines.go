package core

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/internal/auth"
	"github.com/sakana-1314/mpanel/internal/config"
	"github.com/sakana-1314/mpanel/internal/httpapi"
	"github.com/sakana-1314/mpanel/internal/protocol"
	"github.com/sakana-1314/mpanel/internal/store"
	"github.com/sakana-1314/mpanel/internal/tunnel"
)

// machineRecord is the persisted machine document. Secrets are stored as a
// SHA-256 (reverse-ws machine secret) or AES-GCM ciphertext (http/stdio token).
type machineRecord struct {
	ID           string                     `json:"id"`
	Name         string                     `json:"name"`
	Transport    string                     `json:"transport"`
	Enabled      bool                       `json:"enabled"`
	DesiredState string                     `json:"desiredState"`
	URL          string                     `json:"url,omitempty"`
	TokenCipher  string                     `json:"tokenCipher,omitempty"`
	SecretHash   string                     `json:"secretHash,omitempty"`
	Command      string                     `json:"command,omitempty"`
	Args         []string                   `json:"args,omitempty"`
	Env          map[string]string          `json:"env,omitempty"`
	Status       string                     `json:"status"`
	Worker       *protocol.WorkerDescriptor `json:"worker,omitempty"`
	Capabilities *protocol.Capabilities     `json:"capabilities,omitempty"`
	LastSeenAt   *string                    `json:"lastSeenAt,omitempty"`
	LastError    *string                    `json:"lastError,omitempty"`
	Failures     int                        `json:"failures,omitempty"`
	Edge         bool                       `json:"edge,omitempty"`
	Group        *string                    `json:"group,omitempty"`
	EdgeKeyID    *string                    `json:"edgeKeyId,omitempty"`
	Snapshot     *protocol.SystemSnapshot   `json:"snapshot,omitempty"`
	CreatedAt    string                     `json:"createdAt"`
	UpdatedAt    string                     `json:"updatedAt"`
}

type machineDoc struct {
	Machines []machineRecord `json:"machines"`
}

func (rec *machineRecord) view(status string) protocol.Machine {
	endpoint := ""
	httpOnly := status
	_ = httpOnly
	var endpointPtr *string
	switch rec.Transport {
	case protocol.TransportHTTP:
		e := rec.URL
		endpointPtr = &e
	case protocol.TransportReverseWS:
		e := ""
		endpointPtr = &e
	}
	_ = endpoint
	return protocol.Machine{
		ID:                rec.ID,
		Name:              rec.Name,
		Transport:         rec.Transport,
		Status:            status,
		Enabled:           rec.Enabled,
		DesiredState:      rec.DesiredState,
		Endpoint:          endpointPtr,
		HasToken:          rec.TokenCipher != "" || rec.SecretHash != "",
		Worker:            rec.Worker,
		Capabilities:      rec.Capabilities,
		LastSeenAt:        rec.LastSeenAt,
		LastError:         rec.LastError,
		ReconnectAttempts: rec.Failures,
		CreatedAt:         rec.CreatedAt,
		UpdatedAt:         rec.UpdatedAt,
		Edge:              rec.Edge,
		Group:             rec.Group,
		EdgeKeyID:         rec.EdgeKeyID,
		Snapshot:          rec.Snapshot,
	}
}

// MachineManager owns machine state and the child-process stdio transports.
type MachineManager struct {
	cfg     *config.App
	log     *slog.Logger
	store   *store.Store[machineDoc]
	key     []byte
	tunnels *tunnel.Server
	audit   *AuditLog

	mu      sync.Mutex
	procs   map[string]*stdioProcess
	httpMu  sync.Mutex
	clients map[string]*http.Client
	closed  bool
}

func NewMachineManager(cfg *config.App, log *slog.Logger, tunnels *tunnel.Server, audit *AuditLog) *MachineManager {
	return &MachineManager{
		cfg:     cfg,
		log:     log,
		store:   store.Open(filepath.Join(cfg.System.DBPath, "machines.json"), func() machineDoc { return machineDoc{Machines: []machineRecord{}} }),
		key:     auth.EncryptKey(cfg.System.Secret),
		tunnels: tunnels,
		audit:   audit,
		procs:   map[string]*stdioProcess{},
		clients: map[string]*http.Client{},
	}
}

// Start launches the periodic health probe and resumes stdio machines.
func (m *MachineManager) Start(ctx context.Context) {
	records, err := m.records()
	if err != nil {
		m.log.Warn("读取机器列表失败", "error", err.Error())
		return
	}
	for _, rec := range records {
		if rec.Transport == protocol.TransportStdio && rec.Enabled && rec.DesiredState == "running" {
			if err := m.ensureStdio(rec); err != nil {
				m.log.Warn("stdio 机器启动失败", "machineId", rec.ID, "error", err.Error())
			}
		}
	}
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		m.probeAll()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.probeAll()
			}
		}
	}()
}

// Close stops child processes.
func (m *MachineManager) Close() {
	m.mu.Lock()
	m.closed = true
	procs := m.procs
	m.procs = map[string]*stdioProcess{}
	m.mu.Unlock()
	for id, proc := range procs {
		proc.stop()
		m.log.Info("已停止 stdio 机器", "machineId", id)
	}
}

func (m *MachineManager) records() ([]machineRecord, error) {
	doc, err := m.store.Read()
	return doc.Machines, err
}

func (m *MachineManager) find(id string) (machineRecord, bool, error) {
	doc, err := m.store.Read()
	if err != nil {
		return machineRecord{}, false, err
	}
	for _, rec := range doc.Machines {
		if rec.ID == id {
			return rec, true, nil
		}
	}
	return machineRecord{}, false, nil
}

func (m *MachineManager) mutate(fn func(*machineDoc) error) error {
	return m.store.Update(fn)
}

// List returns all machines newest first with live status.
func (m *MachineManager) List() ([]protocol.Machine, error) {
	records, err := m.records()
	if err != nil {
		return nil, err
	}
	out := make([]protocol.Machine, 0, len(records))
	for _, rec := range records {
		out = append(out, rec.view(m.liveStatus(rec)))
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].CreatedAt > out[j-1].CreatedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// Get returns one machine.
func (m *MachineManager) Get(id string) (protocol.Machine, error) {
	rec, ok, err := m.find(id)
	if err != nil {
		return protocol.Machine{}, err
	}
	if !ok {
		return protocol.Machine{}, protocol.NotFound("machine", id)
	}
	return rec.view(m.liveStatus(rec)), nil
}

func (m *MachineManager) liveStatus(rec machineRecord) string {
	if !rec.Enabled || rec.DesiredState != "running" {
		return protocol.StatusOffline
	}
	switch rec.Transport {
	case protocol.TransportReverseWS:
		if m.tunnels.Online(rec.ID) {
			return protocol.StatusOnline
		}
		return protocol.StatusOffline
	case protocol.TransportStdio:
		m.mu.Lock()
		proc := m.procs[rec.ID]
		m.mu.Unlock()
		if proc != nil && proc.running() {
			return protocol.StatusOnline
		}
		return protocol.StatusOffline
	default:
		if rec.Status == "" {
			return protocol.StatusOffline
		}
		return rec.Status
	}
}

/* --------------------------------- create -------------------------------- */

func (m *MachineManager) create(input protocol.MachineCreateInput) (protocol.MachineCreateResult, error) {
	name := strings.TrimSpace(input.Name)
	if name == "" || len([]rune(name)) > 64 {
		return protocol.MachineCreateResult{}, protocol.BadRequest("机器名称必填且不超过 64 个字符")
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	now := store.Now()
	rec := machineRecord{
		ID:           "m_" + protocol.RandomID(9),
		Name:         name,
		Transport:    input.Transport,
		Enabled:      enabled,
		DesiredState: "running",
		Status:       protocol.StatusOffline,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	var enrollment *protocol.MachineEnrollment
	switch input.Transport {
	case protocol.TransportHTTP:
		if strings.TrimSpace(input.URL) == "" || strings.TrimSpace(input.Token) == "" {
			return protocol.MachineCreateResult{}, protocol.BadRequest("http 传输需要 url 与 token")
		}
		sealed, err := auth.Seal(m.key, input.Token)
		if err != nil {
			return protocol.MachineCreateResult{}, err
		}
		rec.URL = strings.TrimRight(input.URL, "/")
		rec.TokenCipher = sealed
	case protocol.TransportStdio:
		if os.Getenv("MPANEL_ALLOW_STDIO") == "" || os.Getenv("MPANEL_ALLOW_STDIO") == "0" {
			return protocol.MachineCreateResult{}, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "未启用 stdio 机器", Hint: "在 core 设置 MPANEL_ALLOW_STDIO=1（等价于允许 core 主机执行命令）。"}
		}
		if strings.TrimSpace(input.Token) == "" {
			return protocol.MachineCreateResult{}, protocol.BadRequest("stdio 传输需要 token")
		}
		sealed, err := auth.Seal(m.key, input.Token)
		if err != nil {
			return protocol.MachineCreateResult{}, err
		}
		rec.TokenCipher = sealed
		rec.Command = input.Command
		rec.Args = input.Args
		rec.Env = input.Env
	case protocol.TransportReverseWS:
		secret := "mp_" + protocol.RandomID(24)
		rec.SecretHash = auth.SHA256Hex(secret)
		workerToken := "agent_" + protocol.RandomID(24)
		sealed, err := auth.Seal(m.key, workerToken)
		if err != nil {
			return protocol.MachineCreateResult{}, err
		}
		rec.TokenCipher = sealed
		wsURL := m.publicWSURL()
		enrollment = &protocol.MachineEnrollment{
			MachineID: rec.ID,
			URL:       wsURL,
			Secret:    secret,
			WorkerEnv: map[string]string{
				"MPANEL_TRANSPORT":      "reverse-ws",
				"MPANEL_CORE_URL":       m.publicBaseURL(),
				"MPANEL_MACHINE_ID":     rec.ID,
				"MPANEL_MACHINE_SECRET": secret,
				"MPANEL_AGENT_TOKEN":    workerToken,
			},
		}
	default:
		return protocol.MachineCreateResult{}, protocol.BadRequest("未知的传输类型")
	}
	if err := m.mutate(func(doc *machineDoc) error {
		doc.Machines = append(doc.Machines, rec)
		return nil
	}); err != nil {
		return protocol.MachineCreateResult{}, err
	}
	if rec.Transport == protocol.TransportStdio && enabled {
		if err := m.ensureStdio(rec); err != nil {
			m.log.Warn("stdio 机器启动失败", "machineId", rec.ID, "error", err.Error())
		}
	}
	if rec.Transport == protocol.TransportHTTP && enabled {
		go func() { m.probeOne(rec.ID) }()
	}
	m.audit.Write("machine.create", rec.ID, "ok", map[string]any{"transport": rec.Transport})
	return protocol.MachineCreateResult{Machine: rec.view(m.liveStatus(rec)), Enrollment: enrollment}, nil
}

// CreateFromEdge creates a reverse-ws machine on behalf of an edge enrollment.
func (m *MachineManager) CreateFromEdge(name, group string, edgeKeyID string) (protocol.Machine, string, error) {
	now := store.Now()
	secret := "mp_" + protocol.RandomID(24)
	rec := machineRecord{
		ID:           "m_" + protocol.RandomID(9),
		Name:         name,
		Transport:    protocol.TransportReverseWS,
		Enabled:      true,
		DesiredState: "running",
		Status:       protocol.StatusOffline,
		SecretHash:   auth.SHA256Hex(secret),
		Edge:         true,
		EdgeKeyID:    protocol.StrPtr(edgeKeyID),
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if group != "" {
		rec.Group = protocol.StrPtr(group)
	}
	if err := m.mutate(func(doc *machineDoc) error {
		doc.Machines = append(doc.Machines, rec)
		return nil
	}); err != nil {
		return protocol.Machine{}, "", err
	}
	m.audit.Write("edge.enroll", rec.ID, "ok", map[string]any{"edgeKeyId": edgeKeyID, "name": name})
	return rec.view(protocol.StatusOffline), secret, nil
}

/* --------------------------------- update -------------------------------- */

func (m *MachineManager) update(id string, input protocol.MachineUpdateInput) (protocol.Machine, error) {
	rec, ok, err := m.find(id)
	if err != nil {
		return protocol.Machine{}, err
	}
	if !ok {
		return protocol.Machine{}, protocol.NotFound("machine", id)
	}
	if input.Name != nil {
		name := strings.TrimSpace(*input.Name)
		if name == "" || len([]rune(name)) > 64 {
			return protocol.Machine{}, protocol.BadRequest("机器名称必填且不超过 64 个字符")
		}
		rec.Name = name
	}
	if input.Enabled != nil {
		rec.Enabled = *input.Enabled
	}
	if input.Group != nil {
		group := strings.TrimSpace(*input.Group)
		if group == "" {
			rec.Group = nil
		} else {
			rec.Group = &group
		}
	}
	if input.URL != nil {
		rec.URL = strings.TrimRight(*input.URL, "/")
	}
	if input.Token != nil {
		sealed, err := auth.Seal(m.key, *input.Token)
		if err != nil {
			return protocol.Machine{}, err
		}
		rec.TokenCipher = sealed
	}
	if input.Command != nil {
		rec.Command = *input.Command
	}
	if input.Args != nil {
		rec.Args = *input.Args
	}
	if input.Env != nil {
		rec.Env = *input.Env
	}
	rec.UpdatedAt = store.Now()
	if err := m.mutate(func(doc *machineDoc) error {
		for i := range doc.Machines {
			if doc.Machines[i].ID == id {
				doc.Machines[i] = rec
				return nil
			}
		}
		return nil
	}); err != nil {
		return protocol.Machine{}, err
	}
	if rec.Transport == protocol.TransportStdio {
		if rec.Enabled && rec.DesiredState == "running" {
			if err := m.ensureStdio(rec); err != nil {
				m.log.Warn("stdio 重载失败", "machineId", id, "error", err.Error())
			}
		} else {
			m.stopStdio(id)
		}
	}
	m.audit.Write("machine.update", id, "ok", nil)
	return rec.view(m.liveStatus(rec)), nil
}

func (m *MachineManager) remove(id string) error {
	rec, ok, err := m.find(id)
	if err != nil {
		return err
	}
	if !ok {
		return protocol.NotFound("machine", id)
	}
	m.stopStdio(id)
	if rec.Transport == protocol.TransportReverseWS {
		if session := m.tunnels.Get(id); session != nil {
			session.SelfClose()
		}
	}
	err = m.mutate(func(doc *machineDoc) error {
		out := doc.Machines[:0]
		for _, item := range doc.Machines {
			if item.ID != id {
				out = append(out, item)
			}
		}
		doc.Machines = out
		return nil
	})
	if err == nil {
		m.audit.Write("machine.delete", id, "ok", nil)
	}
	return err
}

func (m *MachineManager) connect(id string) (protocol.Machine, error) {
	return m.setDesired(id, "running")
}

func (m *MachineManager) disconnect(id string) (protocol.Machine, error) {
	rec, err := m.setDesired(id, "stopped")
	if err != nil {
		return rec, err
	}
	m.stopStdio(id)
	if session := m.tunnels.Get(id); session != nil {
		session.SelfClose()
	}
	return rec, nil
}

func (m *MachineManager) setDesired(id, desired string) (protocol.Machine, error) {
	rec, ok, err := m.find(id)
	if err != nil {
		return protocol.Machine{}, err
	}
	if !ok {
		return protocol.Machine{}, protocol.NotFound("machine", id)
	}
	if desired == "running" && !rec.Enabled {
		return protocol.Machine{}, &protocol.PanelError{Code: protocol.CodeConflict, Message: "机器已被禁用，请先启用"}
	}
	rec.DesiredState = desired
	rec.UpdatedAt = store.Now()
	if err := m.mutate(func(doc *machineDoc) error {
		for i := range doc.Machines {
			if doc.Machines[i].ID == id {
				doc.Machines[i] = rec
				return nil
			}
		}
		return nil
	}); err != nil {
		return protocol.Machine{}, err
	}
	if rec.Transport == protocol.TransportStdio && desired == "running" && rec.Enabled {
		if err := m.ensureStdio(rec); err != nil {
			return rec.view(protocol.StatusError), err
		}
	}
	if rec.Transport == protocol.TransportHTTP && desired == "running" {
		go func() { m.probeOne(id) }()
	}
	return rec.view(m.liveStatus(rec)), nil
}

func (m *MachineManager) rotateSecret(id string) (map[string]string, error) {
	rec, ok, err := m.find(id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, protocol.NotFound("machine", id)
	}
	if rec.Transport != protocol.TransportReverseWS {
		return nil, protocol.BadRequest("只有 reverse-ws 机器支持 secret 轮换")
	}
	secret := "mp_" + protocol.RandomID(24)
	rec.SecretHash = auth.SHA256Hex(secret)
	rec.UpdatedAt = store.Now()
	if err := m.mutate(func(doc *machineDoc) error {
		for i := range doc.Machines {
			if doc.Machines[i].ID == id {
				doc.Machines[i] = rec
				return nil
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if session := m.tunnels.Get(id); session != nil {
		session.SelfClose()
	}
	return map[string]string{
		"secret":          secret,
		"machineId":       rec.ID,
		"url":             m.publicWSURL(),
		"MPANEL_CORE_URL": m.publicBaseURL(),
	}, nil
}

/* -------------------------------- health --------------------------------- */

// MarkOnline records a connected tunnel and its descriptor.
func (m *MachineManager) MarkOnline(id string, descriptor *protocol.WorkerDescriptor) {
	m.mutate(func(doc *machineDoc) error {
		for i := range doc.Machines {
			if doc.Machines[i].ID != id {
				continue
			}
			now := store.Now()
			doc.Machines[i].Status = protocol.StatusOnline
			doc.Machines[i].LastSeenAt = &now
			doc.Machines[i].LastError = nil
			doc.Machines[i].Failures = 0
			if descriptor != nil {
				doc.Machines[i].Worker = descriptor
			}
			doc.Machines[i].UpdatedAt = now
			return nil
		}
		return nil
	})
	// Capabilities live on the agent; fetch asynchronously.
	go func() {
		info, err := m.Info(id)
		if err != nil {
			return
		}
		_ = m.mutate(func(doc *machineDoc) error {
			for i := range doc.Machines {
				if doc.Machines[i].ID == id {
					caps := info.Capabilities
					doc.Machines[i].Capabilities = &caps
					return nil
				}
			}
			return nil
		})
	}()
}

// MarkOffline records a disconnected tunnel.
func (m *MachineManager) MarkOffline(id, reason string) {
	_ = m.mutate(func(doc *machineDoc) error {
		for i := range doc.Machines {
			if doc.Machines[i].ID != id {
				continue
			}
			doc.Machines[i].Status = protocol.StatusOffline
			if reason != "" {
				doc.Machines[i].LastError = &reason
			}
			doc.Machines[i].UpdatedAt = store.Now()
			return nil
		}
		return nil
	})
	m.audit.Write("machine.offline", id, "ok", map[string]any{"reason": reason})
}

func (m *MachineManager) probeAll() {
	records, err := m.records()
	if err != nil {
		return
	}
	for _, rec := range records {
		if rec.Transport == protocol.TransportHTTP && rec.Enabled && rec.DesiredState == "running" {
			m.probeOne(rec.ID)
		}
	}
}

func (m *MachineManager) probeOne(id string) {
	started := time.Now()
	info, err := m.Info(id)
	latency := time.Since(started).Milliseconds()
	_ = m.mutate(func(doc *machineDoc) error {
		for i := range doc.Machines {
			if doc.Machines[i].ID != id {
				continue
			}
			now := store.Now()
			if err != nil {
				doc.Machines[i].Failures++
				message := err.Error()
				doc.Machines[i].LastError = &message
				if doc.Machines[i].Failures >= 3 {
					doc.Machines[i].Status = protocol.StatusOffline
				} else {
					doc.Machines[i].Status = protocol.StatusDegraded
				}
			} else {
				doc.Machines[i].Failures = 0
				doc.Machines[i].Status = protocol.StatusOnline
				doc.Machines[i].LastSeenAt = &now
				doc.Machines[i].LastError = nil
				caps := info.Capabilities
				doc.Machines[i].Capabilities = &caps
				if info.Worker != nil {
					doc.Machines[i].Worker = info.Worker
				}
			}
			doc.Machines[i].UpdatedAt = now
			_ = latency
			return nil
		}
		return nil
	})
}

// Health returns the stored health snapshot.
func (m *MachineManager) Health(id string) (protocol.MachineHealth, error) {
	rec, ok, err := m.find(id)
	if err != nil {
		return protocol.MachineHealth{}, err
	}
	if !ok {
		return protocol.MachineHealth{}, protocol.NotFound("machine", id)
	}
	return protocol.MachineHealth{
		MachineID:           rec.ID,
		Status:              m.liveStatus(rec),
		LastSeenAt:          rec.LastSeenAt,
		ConsecutiveFailures: rec.Failures,
		LastError:           rec.LastError,
		CheckedAt:           store.Now(),
	}, nil
}

// Test probes a machine and returns the result without failing the request.
func (m *MachineManager) Test(id string) (protocol.MachineTestResult, error) {
	started := time.Now()
	info, err := m.Info(id)
	if err != nil {
		message := err.Error()
		return protocol.MachineTestResult{Reachable: false, Error: message}, nil
	}
	latency := time.Since(started).Milliseconds()
	return protocol.MachineTestResult{Reachable: true, LatencyMs: &latency, Info: &info}, nil
}

// Info fetches /api/v1/system/info through the machine's transport.
func (m *MachineManager) Info(id string) (protocol.SystemInfo, error) {
	transport, err := m.Transport(id)
	if err != nil {
		return protocol.SystemInfo{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	resp, err := transport.Do(ctx, http.MethodGet, "/api/v1/system/info", nil, nil)
	if err != nil {
		return protocol.SystemInfo{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return protocol.SystemInfo{}, protocol.Upstream("读取 system/info 失败")
	}
	var envelope struct {
		OK   bool                `json:"ok"`
		Data protocol.SystemInfo `json:"data"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil || !envelope.OK {
		return protocol.SystemInfo{}, protocol.Upstream("agent 返回的 system/info 无效")
	}
	return envelope.Data, nil
}

// AuthenticateReverseWs validates the Bearer secret of a registering agent.
func (m *MachineManager) AuthenticateReverseWs(r *http.Request) (machineRecord, error) {
	secret := bearer(r)
	if secret == "" {
		secret = r.URL.Query().Get("secret")
	}
	if secret == "" {
		return machineRecord{}, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "缺少机器注册凭据", Hint: "GET /ws/worker 必须携带 Authorization: Bearer <machine secret>"}
	}
	hash := auth.SHA256Hex(secret)
	records, err := m.records()
	if err != nil {
		return machineRecord{}, err
	}
	for _, rec := range records {
		if rec.SecretHash != "" && constantTimeEqual(rec.SecretHash, hash) {
			if rec.Transport != protocol.TransportReverseWS {
				return machineRecord{}, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "该机器不是 reverse-ws 传输"}
			}
			if !rec.Enabled {
				return machineRecord{}, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "机器已禁用"}
			}
			if rec.DesiredState != "running" {
				return machineRecord{}, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "机器已被断开，拒绝重连", Hint: "在面板中重新连接后再试"}
			}
			return rec, nil
		}
	}
	return machineRecord{}, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "机器 secret 无效"}
}

// UpdateSnapshot stores the edge node snapshot.
func (m *MachineManager) UpdateSnapshot(id string, snapshot *protocol.SystemSnapshot) {
	_ = m.mutate(func(doc *machineDoc) error {
		for i := range doc.Machines {
			if doc.Machines[i].ID == id {
				doc.Machines[i].Snapshot = snapshot
				doc.Machines[i].UpdatedAt = store.Now()
				return nil
			}
		}
		return nil
	})
}

// EdgeMachines returns reverse-ws machines that were enrolled by an edge key.
func (m *MachineManager) EdgeMachines() ([]machineRecord, error) {
	records, err := m.records()
	if err != nil {
		return nil, err
	}
	out := make([]machineRecord, 0, len(records))
	for _, rec := range records {
		if rec.Edge {
			out = append(out, rec)
		}
	}
	return out, nil
}

/* ------------------------------- endpoints ------------------------------- */

func (m *MachineManager) handleList(w http.ResponseWriter, r *http.Request) {
	machines, err := m.List()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	query := r.URL.Query()
	filtered := make([]protocol.Machine, 0, len(machines))
	for _, machine := range machines {
		if status := query.Get("status"); status != "" && machine.Status != status {
			continue
		}
		if transport := query.Get("transport"); transport != "" && machine.Transport != transport {
			continue
		}
		if q := strings.ToLower(strings.TrimSpace(query.Get("q"))); q != "" {
			if !strings.Contains(strings.ToLower(machine.Name), q) && !strings.Contains(strings.ToLower(machine.ID), q) {
				continue
			}
		}
		filtered = append(filtered, machine)
	}
	items, next, total := protocol.Page(filtered, atoiDefault(query.Get("limit"), 50), query.Get("cursor"))
	httpapi.OK(w, protocol.ListResult[protocol.Machine]{Available: true, Items: items, NextCursor: next, Total: &total})
}

func (m *MachineManager) handleCreate(w http.ResponseWriter, r *http.Request) {
	var input protocol.MachineCreateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	result, err := m.create(input)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.Created(w, result)
}

func (m *MachineManager) handleGet(w http.ResponseWriter, r *http.Request) {
	machine, err := m.Get(r.PathValue("id"))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, machine)
}

func (m *MachineManager) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var input protocol.MachineUpdateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	machine, err := m.update(r.PathValue("id"), input)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, machine)
}

func (m *MachineManager) handleDelete(w http.ResponseWriter, r *http.Request) {
	if err := m.remove(r.PathValue("id")); err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, map[string]any{"deleted": true})
}

func (m *MachineManager) handleConnect(w http.ResponseWriter, r *http.Request) {
	machine, err := m.connect(r.PathValue("id"))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, machine)
}

func (m *MachineManager) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	machine, err := m.disconnect(r.PathValue("id"))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, machine)
}

func (m *MachineManager) handleTest(w http.ResponseWriter, r *http.Request) {
	result, err := m.Test(r.PathValue("id"))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, result)
}

func (m *MachineManager) handleHealth(w http.ResponseWriter, r *http.Request) {
	health, err := m.Health(r.PathValue("id"))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, health)
}

func (m *MachineManager) handleRotate(w http.ResponseWriter, r *http.Request) {
	secret, err := m.rotateSecret(r.PathValue("id"))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, secret)
}

/* ------------------------------ stdio procs ------------------------------ */

type stdioProcess struct {
	cmd     *exec.Cmd
	mu      sync.Mutex
	stopped bool
	done    chan struct{}
}

func (p *stdioProcess) running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (p *stdioProcess) stop() {
	p.mu.Lock()
	p.stopped = true
	p.mu.Unlock()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

func (m *MachineManager) ensureStdio(rec machineRecord) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return errors.New("core 正在关闭")
	}
	if existing := m.procs[rec.ID]; existing != nil && existing.running() {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	command := rec.Command
	if command == "" {
		command = os.Getenv("MPANEL_AGENT_ENTRY")
	}
	if command == "" {
		command = "mpanel-agent"
	}
	args := rec.Args
	if len(args) == 0 {
		args = []string{"serve"}
	}
	token, err := auth.Open(m.key, rec.TokenCipher)
	if err != nil {
		return errors.New("机器 token 解密失败")
	}
	home := filepath.Join(m.cfg.System.BaseDir, "machines", rec.ID)
	cmd := exec.Command(command, args...)
	env := append(os.Environ(),
		"MPANEL_AGENT_TRANSPORT=stdio",
		"MPANEL_AGENT_TOKEN="+token,
		"MPANEL_AGENT_BASE_DIR="+home,
		"MPANEL_MACHINE_ID="+rec.ID,
		"MPANEL_LOG_LEVEL="+m.cfg.Log.Level,
	)
	for key, value := range rec.Env {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return errors.New("启动 agent 失败: " + err.Error())
	}
	proc := &stdioProcess{cmd: cmd, done: make(chan struct{})}
	m.mu.Lock()
	m.procs[rec.ID] = proc
	m.mu.Unlock()
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			m.log.Info("[agent stderr] "+scanner.Text(), "machineId", rec.ID)
		}
	}()
	go func() {
		<-proc.done
		m.MarkOffline(rec.ID, "stdio agent 进程已退出")
	}()
	go func() {
		_, _ = m.tunnels.ServeStream(context.Background(), rec.ID, stdout, stdin)
	}()
	go func() {
		_ = cmd.Wait()
		close(proc.done)
		m.mu.Lock()
		if m.procs[rec.ID] == proc {
			delete(m.procs, rec.ID)
		}
		m.mu.Unlock()
	}()
	m.MarkOnline(rec.ID, nil)
	return nil
}

func (m *MachineManager) stopStdio(id string) {
	m.mu.Lock()
	proc := m.procs[id]
	delete(m.procs, id)
	m.mu.Unlock()
	if proc != nil {
		proc.stop()
	}
}

/* --------------------------------- urls ---------------------------------- */

func (m *MachineManager) publicBaseURL() string {
	if value := strings.TrimSpace(os.Getenv("MPANEL_PUBLIC_URL")); value != "" {
		return strings.TrimRight(value, "/")
	}
	host := m.cfg.System.BindAddress
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + host + ":" + itoa(m.cfg.System.Port)
}

func (m *MachineManager) publicWSURL() string {
	base := m.publicBaseURL()
	if strings.HasPrefix(base, "https://") {
		return "wss://" + strings.TrimPrefix(base, "https://") + "/ws/worker"
	}
	return "ws://" + strings.TrimPrefix(base, "http://") + "/ws/worker"
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [8]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[i:])
}

func atoiDefault(value string, fallback int) int {
	if value == "" {
		return fallback
	}
	result := 0
	for _, r := range value {
		if r < '0' || r > '9' {
			return fallback
		}
		result = result*10 + int(r-'0')
		if result > 1000 {
			return 1000
		}
	}
	return result
}

var _ = runtime.GOOS

// isStdioRunning reports whether a stdio child process is alive.
func (m *MachineManager) isStdioRunning(id string) bool {
	m.mu.Lock()
	proc := m.procs[id]
	m.mu.Unlock()
	return proc != nil && proc.running()
}

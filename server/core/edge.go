package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/core/auth"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
	"github.com/sakana-1314/mpanel/server/core/store"
)

const (
	edgeEnrollPerMinute = 10
	edgeJobResultBytes  = 16 * 1024
	edgeSnapshotMaxAge  = 5 * time.Minute
)

type keyDoc struct {
	Keys []protocol.EdgeKeyRecord `json:"keys"`
}

type jobRecord struct {
	protocol.EdgeJob
	Attempts int `json:"attempts,omitempty"`
}

type jobDoc struct {
	Jobs []jobRecord `json:"jobs"`
}

// EdgeService implements edge keys, enrollment, snapshots and async jobs.
type EdgeService struct {
	cfg      *config.App
	log      *slog.Logger
	machines *MachineManager
	audit    *AuditLog
	keys     *store.Store[keyDoc]
	jobs     *store.Store[jobDoc]

	rateMu  sync.Mutex
	buckets map[string][]time.Time

	cancel context.CancelFunc
	done   chan struct{}
}

// NewEdgeService creates the edge subsystem (call Start to run the dispatcher).
func NewEdgeService(cfg *config.App, log *slog.Logger, machines *MachineManager, audit *AuditLog) *EdgeService {
	dir := cfg.System.DBPath
	return &EdgeService{
		cfg:      cfg,
		log:      log,
		machines: machines,
		audit:    audit,
		keys:     store.Open(filepath.Join(dir, "edge-keys.json"), func() keyDoc { return keyDoc{Keys: []protocol.EdgeKeyRecord{}} }),
		jobs:     store.Open(filepath.Join(dir, "edge-jobs.json"), func() jobDoc { return jobDoc{Jobs: []jobRecord{}} }),
		buckets:  map[string][]time.Time{},
		done:     make(chan struct{}),
	}
}

// Start launches the 10s dispatcher and snapshot refresher.
func (e *EdgeService) Start(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	e.cancel = cancel
	go func() {
		defer close(e.done)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				e.tick(runCtx)
			}
		}
	}()
}

// Stop stops the dispatcher.
func (e *EdgeService) Stop() {
	if e.cancel != nil {
		e.cancel()
		<-e.done
	}
}

/* --------------------------------- keys ---------------------------------- */

func (e *EdgeService) handleListKeys(w http.ResponseWriter, r *http.Request) {
	doc, err := e.keys.Read()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	sort.Slice(doc.Keys, func(i, j int) bool { return doc.Keys[i].CreatedAt > doc.Keys[j].CreatedAt })
	public := make([]protocol.EdgeKey, 0, len(doc.Keys))
	for _, rec := range doc.Keys {
		public = append(public, rec.EdgeKey)
	}
	items, next, total := protocol.Page(public, atoiDefault(r.URL.Query().Get("limit"), 50), r.URL.Query().Get("cursor"))
	httpapi.OK(w, protocol.ListResult[protocol.EdgeKey]{Available: true, Items: items, NextCursor: next, Total: &total})
}

func (e *EdgeService) handleCreateKey(w http.ResponseWriter, r *http.Request) {
	var input protocol.EdgeKeyCreateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" || len([]rune(name)) > 64 {
		httpapi.Fail(w, protocol.BadRequest("密钥名称必填且不超过 64 个字符"))
		return
	}
	maxUses := 0
	if input.MaxUses != nil {
		if *input.MaxUses < 0 || *input.MaxUses > 100000 {
			httpapi.Fail(w, protocol.BadRequest("maxUses 必须在 0 到 100000 之间"))
			return
		}
		maxUses = *input.MaxUses
	}
	now := time.Now().UTC()
	record := protocol.EdgeKeyRecord{
		EdgeKey: protocol.EdgeKey{
			ID:        "edgekey_" + protocol.RandomID(9),
			Name:      name,
			CreatedAt: now.Format(time.RFC3339),
			MaxUses:   maxUses,
		},
	}
	if input.Group != nil {
		group := strings.TrimSpace(*input.Group)
		if group != "" {
			record.Group = &group
		}
	}
	if input.TTLSec != nil && *input.TTLSec > 0 {
		record.ExpiresAt = protocol.StrPtr(now.Add(time.Duration(*input.TTLSec) * time.Second).Format(time.RFC3339))
	}
	secret := "mpedge_" + protocol.RandomID(24)
	record.SecretHash = auth.SHA256Hex(secret)
	if err := e.keys.Update(func(doc *keyDoc) error {
		doc.Keys = append(doc.Keys, record)
		return nil
	}); err != nil {
		httpapi.Fail(w, err)
		return
	}
	e.audit.Write("edge.key.create", record.ID, "ok", map[string]any{"name": name, "group": record.Group, "maxUses": maxUses})
	httpapi.Created(w, protocol.EdgeKeyCreateResult{Key: record.EdgeKey, Secret: secret})
}

func (e *EdgeService) handleRevokeKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := e.keys.Update(func(doc *keyDoc) error {
		for i := range doc.Keys {
			if doc.Keys[i].ID != id {
				continue
			}
			if doc.Keys[i].RevokedAt == nil {
				doc.Keys[i].RevokedAt = protocol.StrPtr(store.Now())
			}
			return nil
		}
		return protocol.NotFound("edge key", id)
	})
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	e.audit.Write("edge.key.revoke", id, "ok", nil)
	httpapi.OK(w, map[string]any{"revoked": true})
}

/* -------------------------------- enroll --------------------------------- */

func (e *EdgeService) allowEnroll(ip string) bool {
	e.rateMu.Lock()
	defer e.rateMu.Unlock()
	now := time.Now()
	window := now.Add(-time.Minute)
	entries := e.buckets[ip]
	kept := entries[:0]
	for _, at := range entries {
		if at.After(window) {
			kept = append(kept, at)
		}
	}
	if len(kept) >= edgeEnrollPerMinute {
		e.buckets[ip] = kept
		return false
	}
	e.buckets[ip] = append(kept, now)
	return true
}

func (e *EdgeService) handleEnroll(w http.ResponseWriter, r *http.Request) {
	ip := httpapi.ClientIP(r)
	if !e.allowEnroll(ip) {
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "边缘入网请求过于频繁", Details: map[string]any{"retryAfterSec": 60}})
		return
	}
	var input protocol.EdgeEnrollRequest
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	key := strings.TrimSpace(input.Key)
	if key == "" {
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "缺少入网密钥"})
		return
	}
	hash := auth.SHA256Hex(key)
	doc, err := e.keys.Read()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	var matched *protocol.EdgeKeyRecord
	for i := range doc.Keys {
		if constantTimeEqual(doc.Keys[i].SecretHash, hash) {
			matched = &doc.Keys[i]
			break
		}
	}
	if matched == nil {
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "边缘入网密钥无效", Hint: "确认 MPANEL_EDGE_KEY 与面板中创建的密钥一致"})
		return
	}
	now := time.Now().UTC()
	switch {
	case matched.RevokedAt != nil:
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "边缘入网密钥已吊销"})
		return
	case matched.ExpiresAt != nil && parseTime(*matched.ExpiresAt, now):
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "边缘入网密钥已过期"})
		return
	case matched.MaxUses > 0 && matched.Uses >= matched.MaxUses:
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "边缘入网密钥使用次数已达上限"})
		return
	}
	name := sanitizeMachineName(input.Name)
	if name == "" {
		suffix := protocol.RandomID(3)
		name = sanitizeMachineName(input.Platform + "-" + suffix)
	}
	group := ""
	if matched.Group != nil {
		group = *matched.Group
	}
	machine, secret, err := e.machines.CreateFromEdge(name, group, matched.ID)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	err = e.keys.Update(func(doc *keyDoc) error {
		for i := range doc.Keys {
			if doc.Keys[i].ID == matched.ID {
				doc.Keys[i].Uses++
				doc.Keys[i].LastUsedAt = protocol.StrPtr(store.Now())
				return nil
			}
		}
		return nil
	})
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	e.audit.Write("edge.enroll", machine.ID, "ok", map[string]any{"edgeKeyId": matched.ID, "ip": ip, "name": name})
	httpapi.OK(w, protocol.EdgeEnrollResult{Machine: machine, Secret: secret, WSURL: e.machines.publicWSURL()})
}

func sanitizeMachineName(raw string) string {
	raw = strings.TrimSpace(raw)
	var out []rune
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
	}
	value := strings.Trim(string(out), "-.")
	if len(value) > 64 {
		value = value[:64]
	}
	return value
}

/* --------------------------------- jobs ---------------------------------- */

func (e *EdgeService) handleListJobs(w http.ResponseWriter, r *http.Request) {
	doc, err := e.jobs.Read()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	query := r.URL.Query()
	filtered := make([]protocol.EdgeJob, 0, len(doc.Jobs))
	for _, job := range doc.Jobs {
		if machineID := query.Get("machineId"); machineID != "" && job.MachineID != machineID {
			continue
		}
		if status := query.Get("status"); status != "" && job.Status != status {
			continue
		}
		filtered = append(filtered, job.EdgeJob)
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].CreatedAt > filtered[j].CreatedAt })
	items, next, total := protocol.Page(filtered, atoiDefault(query.Get("limit"), 50), query.Get("cursor"))
	httpapi.OK(w, protocol.ListResult[protocol.EdgeJob]{Available: true, Items: items, NextCursor: next, Total: &total})
}

func (e *EdgeService) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	var input protocol.EdgeJobCreateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	if _, err := e.machines.Get(input.MachineID); err != nil {
		httpapi.Fail(w, err)
		return
	}
	var payload map[string]any
	if input.Payload != nil {
		payload = input.Payload
	} else {
		payload = map[string]any{}
	}
	switch input.Kind {
	case protocol.JobSnapshot:
	case protocol.JobRunTask:
		if _, ok := payload["taskId"].(string); !ok {
			httpapi.Fail(w, protocol.BadRequest("run-task 作业需要 payload.taskId"))
			return
		}
	case protocol.JobApplySite:
		if _, ok := payload["siteId"].(string); !ok {
			httpapi.Fail(w, protocol.BadRequest("apply-site 作业需要 payload.siteId"))
			return
		}
	default:
		httpapi.Fail(w, protocol.BadRequest("未知的作业类型"))
		return
	}
	job := jobRecord{EdgeJob: protocol.EdgeJob{
		ID:        "edgejob_" + protocol.RandomID(9),
		MachineID: input.MachineID,
		Kind:      input.Kind,
		Payload:   payload,
		Status:    protocol.JobPending,
		CreatedAt: store.NowNano(),
	}}
	if err := e.jobs.Update(func(doc *jobDoc) error {
		doc.Jobs = append(doc.Jobs, job)
		return nil
	}); err != nil {
		httpapi.Fail(w, err)
		return
	}
	e.audit.Write("edge.job.create", job.MachineID, "ok", map[string]any{"jobId": job.ID, "kind": job.Kind})
	httpapi.Created(w, job.EdgeJob)
}

func (e *EdgeService) handleGetJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	doc, err := e.jobs.Read()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	for _, job := range doc.Jobs {
		if job.ID == id {
			httpapi.OK(w, job.EdgeJob)
			return
		}
	}
	httpapi.Fail(w, protocol.NotFound("edge job", id))
}

func (e *EdgeService) handleDeleteJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := e.jobs.Update(func(doc *jobDoc) error {
		for i := range doc.Jobs {
			if doc.Jobs[i].ID != id {
				continue
			}
			if doc.Jobs[i].Status != protocol.JobPending {
				return protocol.Conflict("只能删除 pending 作业")
			}
			doc.Jobs = append(doc.Jobs[:i], doc.Jobs[i+1:]...)
			return nil
		}
		return protocol.NotFound("edge job", id)
	})
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	e.audit.Write("edge.job.delete", id, "ok", nil)
	httpapi.OK(w, map[string]any{"deleted": true})
}

func (e *EdgeService) tick(ctx context.Context) {
	e.refreshSnapshots(ctx)
	e.dispatchJobs(ctx)
}

func (e *EdgeService) refreshSnapshots(ctx context.Context) {
	records, err := e.machines.EdgeMachines()
	if err != nil {
		return
	}
	for _, rec := range records {
		if !e.machines.tunnels.Online(rec.ID) {
			continue
		}
		stale := rec.Snapshot == nil
		if rec.Snapshot != nil {
			if at, err := time.Parse(time.RFC3339, rec.Snapshot.CollectedAt); err == nil {
				stale = time.Since(at) > edgeSnapshotMaxAge
			}
		}
		if !stale {
			continue
		}
		snapshot, err := e.fetchSnapshot(ctx, rec.ID)
		if err != nil {
			e.log.Warn("边缘快照失败", "machineId", rec.ID, "error", err.Error())
			continue
		}
		e.machines.UpdateSnapshot(rec.ID, snapshot)
	}
}

func (e *EdgeService) fetchSnapshot(ctx context.Context, machineID string) (*protocol.SystemSnapshot, error) {
	transport, err := e.machines.Transport(machineID)
	if err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	resp, err := transport.Do(reqCtx, http.MethodGet, "/api/v1/system/snapshot", nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, protocol.Upstream("读取快照失败")
	}
	var envelope struct {
		OK   bool                    `json:"ok"`
		Data protocol.SystemSnapshot `json:"data"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil || !envelope.OK {
		return nil, protocol.Upstream("快照响应无效")
	}
	return &envelope.Data, nil
}

func (e *EdgeService) dispatchJobs(ctx context.Context) {
	doc, err := e.jobs.Read()
	if err != nil {
		return
	}
	// One pending job per machine per tick keeps execution serial.
	byMachine := map[string][]jobRecord{}
	for _, job := range doc.Jobs {
		if job.Status == protocol.JobPending || job.Status == protocol.JobRunning {
			byMachine[job.MachineID] = append(byMachine[job.MachineID], job)
		}
	}
	for machineID, jobs := range byMachine {
		sort.Slice(jobs, func(i, j int) bool { return jobs[i].CreatedAt < jobs[j].CreatedAt })
		running := false
		for _, job := range jobs {
			if job.Status == protocol.JobRunning {
				running = true
				break
			}
		}
		if running {
			continue
		}
		if !e.machines.tunnels.Online(machineID) && !e.machines.isStdioRunning(machineID) {
			continue
		}
		e.runJob(ctx, jobs[0])
	}
}

func (e *EdgeService) runJob(ctx context.Context, job jobRecord) {
	_ = e.updateJob(job.ID, func(rec *jobRecord) {
		rec.Status = protocol.JobRunning
		rec.StartedAt = protocol.StrPtr(store.Now())
		rec.Attempts++
	})
	method, path, body, err := jobRequest(job.EdgeJob)
	if err != nil {
		e.finishJob(job.ID, 0, nil, err)
		return
	}
	transport, err := e.machines.Transport(job.MachineID)
	if err != nil {
		// Offline is normal for edge nodes: revert to pending without failing.
		_ = e.updateJob(job.ID, func(rec *jobRecord) {
			rec.Status = protocol.JobPending
			rec.StartedAt = nil
		})
		return
	}
	reqCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	resp, err := transport.Do(reqCtx, method, path, map[string][]string{"Content-Type": {"application/json"}}, body)
	if err != nil {
		if job.Attempts < 1 {
			_ = e.updateJob(job.ID, func(rec *jobRecord) {
				rec.Status = protocol.JobPending
				rec.StartedAt = nil
				rec.Error = protocol.StrPtr(err.Error())
			})
			return
		}
		e.finishJob(job.ID, 0, nil, err)
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var envelope struct {
		OK    bool               `json:"ok"`
		Data  json.RawMessage    `json:"data"`
		Error *protocol.APIError `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		e.finishJob(job.ID, resp.StatusCode, nil, protocol.Upstream("agent 响应不是合法 JSON"))
		return
	}
	if !envelope.OK && envelope.Error != nil {
		e.finishJob(job.ID, resp.StatusCode, nil, &protocol.PanelError{Code: envelope.Error.Code, Message: envelope.Error.Message})
		return
	}
	e.finishJob(job.ID, resp.StatusCode, truncateResult(envelope.Data), nil)
}

func jobRequest(job protocol.EdgeJob) (string, string, []byte, error) {
	switch job.Kind {
	case protocol.JobSnapshot:
		return http.MethodGet, "/api/v1/system/snapshot", nil, nil
	case protocol.JobRunTask:
		taskID, _ := job.Payload["taskId"].(string)
		if taskID == "" {
			return "", "", nil, protocol.BadRequest("run-task 作业缺少 taskId")
		}
		return http.MethodPost, "/api/v1/tasks/" + taskID + "/run", []byte("{}"), nil
	case protocol.JobApplySite:
		siteID, _ := job.Payload["siteId"].(string)
		if siteID == "" {
			return "", "", nil, protocol.BadRequest("apply-site 作业缺少 siteId")
		}
		body, _ := json.Marshal(map[string]any{"siteIds": []string{siteID}})
		return http.MethodPost, "/api/v1/sites/apply", body, nil
	default:
		return "", "", nil, protocol.BadRequest("未知的作业类型")
	}
}

func truncateResult(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	if len(raw) <= edgeJobResultBytes {
		var value any
		if err := json.Unmarshal(raw, &value); err == nil {
			return value
		}
	}
	preview := string(raw)
	if len(preview) > edgeJobResultBytes-128 {
		preview = preview[:edgeJobResultBytes-128] + "…"
	}
	return map[string]any{"truncated": true, "sizeBytes": len(raw), "preview": preview}
}

func (e *EdgeService) finishJob(id string, httpStatus int, result any, failure error) {
	_ = e.updateJob(id, func(rec *jobRecord) {
		rec.FinishedAt = protocol.StrPtr(store.Now())
		if httpStatus != 0 {
			rec.HTTPStatus = protocol.IntPtr(httpStatus)
		}
		if failure != nil {
			rec.Status = protocol.JobFailed
			message := failure.Error()
			rec.Error = &message
			return
		}
		rec.Status = protocol.JobSucceeded
		rec.Result = result
		rec.Error = nil
	})
}

func (e *EdgeService) updateJob(id string, fn func(*jobRecord)) error {
	return e.jobs.Update(func(doc *jobDoc) error {
		for i := range doc.Jobs {
			if doc.Jobs[i].ID == id {
				fn(&doc.Jobs[i])
				return nil
			}
		}
		return protocol.NotFound("edge job", id)
	})
}

func parseTime(value string, now time.Time) bool {
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return true
	}
	return now.After(at)
}

var (
	_ = bytes.NewReader
	_ = fmt.Sprintf
)

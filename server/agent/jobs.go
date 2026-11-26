package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

const (
	maxJobs         = 100
	maxJobLogBytes  = 16 << 10
	jobConcurrency  = 4
	jobPersistEvery = 500 * time.Millisecond
)

// JobReporter is handed to a job body for progress and log updates.
type JobReporter interface {
	SetProgress(percent int, step string)
	SetIndeterminate(value bool)
	Log(line string)
}

// JobSpec describes one long-running operation.
type JobSpec struct {
	Kind        string
	Title       string
	Cancellable bool
	Run         func(ctx context.Context, reporter JobReporter) (any, error)
}

type jobRecord struct {
	job         protocol.Job
	cancel      context.CancelFunc
	lastPersist time.Time
}

// JobManager runs long operations in the background so HTTP handlers can
// return 202 immediately and the panel can poll /jobs/{id}. Jobs are kept in
// memory and persisted to <dataDir>/jobs/jobs.json; a restart marks unfinished
// jobs as failed instead of pretending they still run.
type JobManager struct {
	mu      sync.Mutex
	dataDir string
	logger  *slog.Logger
	jobs    map[string]*jobRecord
	order   []string
	sem     chan struct{}
	now     func() time.Time
}

type jobsDoc struct {
	Version int            `json:"version"`
	Jobs    []protocol.Job `json:"jobs"`
}

// NewJobManager creates the manager and loads persisted job history.
func NewJobManager(dataDir string, logger *slog.Logger) *JobManager {
	if logger == nil {
		logger = slog.Default()
	}
	m := &JobManager{
		dataDir: dataDir,
		logger:  logger,
		jobs:    map[string]*jobRecord{},
		sem:     make(chan struct{}, jobConcurrency),
		now:     time.Now,
	}
	m.load()
	return m
}

func (m *JobManager) path() string {
	if strings.TrimSpace(m.dataDir) == "" {
		return ""
	}
	return filepath.Join(m.dataDir, "jobs", "jobs.json")
}

func (m *JobManager) load() {
	path := m.path()
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			m.logger.Warn("读取任务历史失败", "error", err.Error())
		}
		return
	}
	var doc jobsDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		m.logger.Warn("解析任务历史失败", "error", err.Error())
		return
	}
	now := m.now().UTC().Format(time.RFC3339)
	for _, job := range doc.Jobs {
		if job.Status == protocol.JobStatusQueued || job.Status == protocol.JobStatusRunning {
			job.Status = protocol.JobStatusFailed
			finished := now
			job.FinishedAt = &finished
			job.Step = "agent 重启，任务已中断"
			job.Error = &protocol.JobError{Code: protocol.CodeUnavailable, Message: "agent 重启，任务已中断"}
		}
		copied := job
		m.jobs[job.ID] = &jobRecord{job: copied}
		m.order = append(m.order, job.ID)
	}
	m.pruneLocked()
}

func (m *JobManager) persistLocked() {
	path := m.path()
	if path == "" {
		return
	}
	doc := jobsDoc{Version: 1, Jobs: make([]protocol.Job, 0, len(m.order))}
	for _, id := range m.order {
		if rec, ok := m.jobs[id]; ok {
			doc.Jobs = append(doc.Jobs, rec.job)
		}
	}
	data, err := json.Marshal(doc)
	if err != nil {
		m.logger.Warn("序列化任务历史失败", "error", err.Error())
		return
	}
	if err := config.WriteFileAtomic(path, data, 0o600); err != nil {
		m.logger.Warn("写入任务历史失败", "error", err.Error())
	}
}

func (m *JobManager) persistThrottledLocked(rec *jobRecord, force bool) {
	now := m.now()
	if !force && now.Sub(rec.lastPersist) < jobPersistEvery {
		return
	}
	rec.lastPersist = now
	m.persistLocked()
}

// Submit queues a job and returns the queued snapshot immediately.
func (m *JobManager) Submit(spec JobSpec) (protocol.Job, error) {
	if spec.Run == nil {
		return protocol.Job{}, errors.New("任务缺少执行体")
	}
	kind := strings.TrimSpace(spec.Kind)
	title := strings.TrimSpace(spec.Title)
	if kind == "" {
		return protocol.Job{}, errors.New("任务缺少 kind")
	}
	if title == "" {
		title = kind
	}
	ctx, cancel := context.WithCancel(context.Background())
	now := m.now().UTC().Format(time.RFC3339)
	job := protocol.Job{
		ID:          "job_" + protocol.RandomID(10),
		Kind:        kind,
		Title:       title,
		Status:      protocol.JobStatusQueued,
		Progress:    0,
		Step:        "等待执行",
		Cancellable: spec.Cancellable,
		CreatedAt:   now,
	}
	rec := &jobRecord{job: job, cancel: cancel}
	m.mu.Lock()
	m.pruneLocked()
	m.jobs[job.ID] = rec
	m.order = append(m.order, job.ID)
	m.persistLocked()
	m.mu.Unlock()

	go m.run(ctx, rec, spec.Run)
	return job, nil
}

func (m *JobManager) run(ctx context.Context, rec *jobRecord, run func(context.Context, JobReporter) (any, error)) {
	select {
	case m.sem <- struct{}{}:
		defer func() { <-m.sem }()
	case <-ctx.Done():
		m.finish(rec, nil, ctx.Err())
		return
	}
	m.mu.Lock()
	rec.job.Status = protocol.JobStatusRunning
	started := m.now().UTC().Format(time.RFC3339)
	rec.job.StartedAt = &started
	rec.job.Step = "开始执行"
	rec.job.Progress = 1
	m.persistLocked()
	m.mu.Unlock()

	reporter := &jobReporter{manager: m, id: rec.job.ID}
	result, err := run(ctx, reporter)
	m.finish(rec, result, err)
}

func (m *JobManager) finish(rec *jobRecord, result any, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	finished := m.now().UTC().Format(time.RFC3339)
	rec.job.FinishedAt = &finished
	if err != nil {
		var nilPanel *protocol.PanelError
		if errors.As(err, &nilPanel) && nilPanel == nil {
			err = nil
		}
	}
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			rec.job.Status = protocol.JobStatusCancelled
			rec.job.Step = "已取消"
			rec.job.Error = &protocol.JobError{Code: protocol.CodeUnavailable, Message: "任务已取消"}
		} else {
			rec.job.Status = protocol.JobStatusFailed
			rec.job.Error = jobError(err)
			if rec.job.Step == "" {
				rec.job.Step = "失败"
			}
		}
	} else {
		rec.job.Status = protocol.JobStatusSucceeded
		rec.job.Progress = 100
		rec.job.Indeterminate = false
		rec.job.Step = "完成"
		rec.job.Result = result
	}
	m.persistLocked()
}

func jobError(err error) *protocol.JobError {
	var pe *protocol.PanelError
	if errors.As(err, &pe) && pe != nil {
		return &protocol.JobError{
			Code:    pe.Code,
			Message: pe.Message,
			Hint:    pe.Hint,
			Details: pe.Details,
		}
	}
	return &protocol.JobError{Code: protocol.CodeInternal, Message: "任务执行失败"}
}

type jobReporter struct {
	manager *JobManager
	id      string
}

func (r *jobReporter) SetProgress(percent int, step string) {
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	r.manager.mu.Lock()
	defer r.manager.mu.Unlock()
	rec, ok := r.manager.jobs[r.id]
	if !ok || terminal(rec.job.Status) {
		return
	}
	rec.job.Progress = percent
	rec.job.Indeterminate = false
	if strings.TrimSpace(step) != "" {
		rec.job.Step = step
	}
	r.manager.persistThrottledLocked(rec, false)
}

func (r *jobReporter) SetIndeterminate(value bool) {
	r.manager.mu.Lock()
	defer r.manager.mu.Unlock()
	rec, ok := r.manager.jobs[r.id]
	if !ok || terminal(rec.job.Status) {
		return
	}
	rec.job.Indeterminate = value
	r.manager.persistThrottledLocked(rec, false)
}

func (r *jobReporter) Log(line string) {
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return
	}
	r.manager.mu.Lock()
	defer r.manager.mu.Unlock()
	rec, ok := r.manager.jobs[r.id]
	if !ok || terminal(rec.job.Status) {
		return
	}
	logs := rec.job.Logs
	if logs != "" {
		logs += "\n"
	}
	logs += line
	if len(logs) > maxJobLogBytes {
		logs = "..." + logs[len(logs)-maxJobLogBytes:]
	}
	rec.job.Logs = logs
	r.manager.persistThrottledLocked(rec, false)
}

func (m *JobManager) Get(id string) (protocol.Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.jobs[id]
	if !ok {
		return protocol.Job{}, false
	}
	return rec.job, true
}

func (m *JobManager) List(status, kind string) []protocol.Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]protocol.Job, 0, len(m.order))
	for _, id := range m.order {
		rec, ok := m.jobs[id]
		if !ok {
			continue
		}
		if status != "" && string(rec.job.Status) != status {
			continue
		}
		if kind != "" && rec.job.Kind != kind {
			continue
		}
		out = append(out, rec.job)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt == out[j].CreatedAt {
			return out[i].ID > out[j].ID
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out
}

// Cancel asks a running job to stop. The handler stays idempotent for terminal
// jobs and returns the current snapshot.
func (m *JobManager) Cancel(id string) (protocol.Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.jobs[id]
	if !ok {
		return protocol.Job{}, false
	}
	if terminal(rec.job.Status) {
		return rec.job, true
	}
	rec.job.Step = "正在取消…"
	rec.cancel()
	m.persistLocked()
	return rec.job, true
}

func (m *JobManager) pruneLocked() {
	if len(m.order) <= maxJobs {
		return
	}
	keep := make([]string, 0, maxJobs)
	removed := len(m.order) - maxJobs
	for _, id := range m.order {
		rec, ok := m.jobs[id]
		if removed > 0 && ok && terminal(rec.job.Status) {
			delete(m.jobs, id)
			removed--
			continue
		}
		keep = append(keep, id)
	}
	m.order = keep
}

func terminal(status protocol.JobStatus) bool {
	return status == protocol.JobStatusSucceeded ||
		status == protocol.JobStatusFailed ||
		status == protocol.JobStatusCancelled
}

// Package tasks implements scheduled shell commands: 5-field cron parsing,
// persistent task definitions, asynchronous runs through the shared command
// runner, and per-task history.
package tasks

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/robfig/cron/v3"
	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/internal/httpapi"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

// Module implements the scheduled-task feature module.
type Module struct {
	mu        sync.Mutex
	historyMu sync.Mutex
	dataDir   string
	runner    agent.Runner
	tasks     map[string]*Task
	entries   map[string]cron.EntryID
	active    map[string]map[string]*activeRun
	scheduler *cron.Cron
}

// New returns the tasks module.
func New() *Module {
	return &Module{
		tasks:   make(map[string]*Task),
		entries: make(map[string]cron.EntryID),
		active:  make(map[string]map[string]*activeRun),
	}
}

// Name implements agent.Module.
func (m *Module) Name() string { return "tasks" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	if ctx == nil || ctx.Mux == nil {
		return errors.New("tasks: 缺少 HTTP mux")
	}
	if ctx.DataDir() == "" {
		return errors.New("tasks: 缺少 agent data dir")
	}
	m.mu.Lock()
	m.dataDir = ctx.DataDir()
	m.runner = ctx.Runner
	m.mu.Unlock()

	if err := m.loadTasks(); err != nil {
		return err
	}

	m.mu.Lock()
	m.scheduler = cron.New()
	for _, task := range m.tasks {
		m.scheduleLocked(task)
	}
	m.scheduler.Start()
	err := m.saveTasksLocked()
	m.mu.Unlock()
	if err != nil {
		return err
	}

	ctx.Mux.HandleFunc("GET /api/v1/tasks", m.handleList)
	ctx.Mux.HandleFunc("POST /api/v1/tasks", m.handleCreate)
	ctx.Mux.HandleFunc("GET /api/v1/tasks/runs", m.handleAllRuns)
	ctx.Mux.HandleFunc("GET /api/v1/tasks/next-runs", m.handleNextRuns)
	ctx.Mux.HandleFunc("GET /api/v1/tasks/{id}", m.handleGet)
	ctx.Mux.HandleFunc("PUT /api/v1/tasks/{id}", m.handleUpdate)
	ctx.Mux.HandleFunc("PATCH /api/v1/tasks/{id}", m.handleUpdate)
	ctx.Mux.HandleFunc("DELETE /api/v1/tasks/{id}", m.handleDelete)
	ctx.Mux.HandleFunc("POST /api/v1/tasks/{id}/run", m.handleRun)
	ctx.Mux.HandleFunc("GET /api/v1/tasks/{id}/history", m.handleHistory)
	ctx.Mux.HandleFunc("DELETE /api/v1/tasks/{id}/history", m.handleDeleteHistory)
	ctx.Mux.HandleFunc("GET /api/v1/tasks/{id}/next-runs", m.handleTaskNextRuns)
	return nil
}

// Close stops the cron scheduler. The agent process normally exits without
// calling it; tests use it to avoid leaking scheduler goroutines.
func (m *Module) Close() {
	m.mu.Lock()
	scheduler := m.scheduler
	m.scheduler = nil
	m.mu.Unlock()
	if scheduler != nil {
		_ = scheduler.Stop()
	}
}

/* -------------------------------- Handlers ------------------------------- */

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	enabled, err := parseEnabledFilter(r)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))

	m.mu.Lock()
	all := make([]*Task, 0, len(m.tasks))
	for _, task := range m.tasks {
		all = append(all, task.clone())
	}
	m.mu.Unlock()

	filtered := make([]*Task, 0, len(all))
	for _, task := range all {
		if enabled != nil && task.Enabled != *enabled {
			continue
		}
		if query != "" && !taskMatches(task, query) {
			continue
		}
		filtered = append(filtered, task)
	}
	sort.Slice(filtered, func(i, j int) bool {
		left, right := strings.ToLower(filtered[i].Name), strings.ToLower(filtered[j].Name)
		if left == right {
			return filtered[i].ID < filtered[j].ID
		}
		return left < right
	})
	limit, cursor := pageParams(r)
	items, next, total := protocol.Page(filtered, limit, cursor)
	httpapi.OK(w, protocol.ListResult[*Task]{
		Available:  true,
		Items:      items,
		NextCursor: next,
		Total:      &total,
	})
}

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	var input taskInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	task, err := m.createTask(input)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.Created(w, task)
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m.mu.Lock()
	task := m.tasks[id]
	var copy *Task
	if task != nil {
		copy = task.clone()
	}
	m.mu.Unlock()
	if copy == nil {
		httpapi.Fail(w, taskNotFound(id))
		return
	}
	httpapi.OK(w, copy)
}

func (m *Module) handleUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var input taskInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	task, err := m.updateTask(id, input)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, task)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	killed, err := m.deleteTask(id)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, struct {
		Deleted   bool   `json:"deleted"`
		ID        string `json:"id"`
		KilledRun string `json:"killedRun,omitempty"`
	}{Deleted: true, ID: id, KilledRun: killed})
}

func (m *Module) handleRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	run, err := m.startRun(id, triggerManual)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, struct {
		Run *TaskRun `json:"run"`
	}{Run: run})
}

func (m *Module) handleHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !m.taskExists(id) {
		httpapi.Fail(w, taskNotFound(id))
		return
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	runs := m.taskHistory(id, status)
	limit, cursor := pageParams(r)
	items, next, total := protocol.Page(runs, limit, cursor)
	httpapi.OK(w, protocol.ListResult[TaskRun]{
		Available:  true,
		Items:      items,
		NextCursor: next,
		Total:      &total,
	})
}

func (m *Module) handleDeleteHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !m.taskExists(id) {
		httpapi.Fail(w, taskNotFound(id))
		return
	}
	if err := m.deleteHistory(id); err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, map[string]any{"deleted": true, "id": id})
}

func (m *Module) handleAllRuns(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.URL.Query().Get("taskId"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	runs := m.allRuns(taskID, status)
	limit, cursor := pageParams(r)
	items, next, total := protocol.Page(runs, limit, cursor)
	httpapi.OK(w, protocol.ListResult[TaskRun]{
		Available:  true,
		Items:      items,
		NextCursor: next,
		Total:      &total,
	})
}

func (m *Module) handleNextRuns(w http.ResponseWriter, r *http.Request) {
	expression := strings.TrimSpace(r.URL.Query().Get("cron"))
	if expression == "" {
		httpapi.Fail(w, protocol.BadRequest("缺少 cron 查询参数"))
		return
	}
	count, err := nextRunsCount(r)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	loc, err := loadLocation(r.URL.Query().Get("timezone"))
	if err != nil {
		httpapi.Fail(w, protocol.BadRequest("时区不是合法的 IANA 名称: "+r.URL.Query().Get("timezone")))
		return
	}
	times, err := nextRunTimes(expression, loc, count)
	if err != nil {
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "无效的 cron 表达式",
			Details: map[string]any{"error": err.Error()},
		})
		return
	}
	httpapi.OK(w, nextRunsResult(times))
}

func (m *Module) handleTaskNextRuns(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m.mu.Lock()
	task := m.tasks[id]
	var copy *Task
	if task != nil {
		copy = task.clone()
	}
	m.mu.Unlock()
	if copy == nil {
		httpapi.Fail(w, taskNotFound(id))
		return
	}
	count, err := nextRunsCount(r)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	times, err := nextRunTimes(copy.Schedule, copy.location(), count)
	if err != nil {
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "任务 cron 表达式无效",
			Details: map[string]any{"error": err.Error()},
		})
		return
	}
	httpapi.OK(w, nextRunsResult(times))
}

type nextRunAt struct {
	At string `json:"at"`
}

type nextRunsResponse struct {
	NextRuns []nextRunAt `json:"nextRuns"`
}

func nextRunsResult(times []string) nextRunsResponse {
	out := make([]nextRunAt, 0, len(times))
	for _, at := range times {
		out = append(out, nextRunAt{At: at})
	}
	return nextRunsResponse{NextRuns: out}
}

/* ------------------------------ Task store ------------------------------- */

func (m *Module) createTask(input taskInput) (*Task, error) {
	if !input.Name.Set || input.Name.Value == nil {
		return nil, protocol.BadRequest("任务名称不能为空")
	}
	schedule, ok := input.scheduleValue()
	if !ok {
		return nil, protocol.BadRequest("cron 表达式不能为空")
	}
	if !input.Command.Set || input.Command.Value == nil {
		return nil, protocol.BadRequest("命令不能为空")
	}

	task := &Task{
		ID:          "task_" + protocol.RandomID(9),
		Name:        *input.Name.Value,
		Description: optionalText(input.Description),
		Schedule:    schedule,
		Timezone:    optionalText(input.Timezone),
		Command:     *input.Command.Value,
		Cwd:         optionalText(input.Cwd),
		Env:         envValue(input.Env),
		Enabled:     true,
		TimeoutSec:  defaultTimeoutSec,
		Overlap:     overlapSkip,
		CreatedAt:   nowString(),
		UpdatedAt:   nowString(),
	}
	if input.Enabled != nil {
		task.Enabled = *input.Enabled
	}
	if input.TimeoutSec != nil {
		if *input.TimeoutSec < 1 || *input.TimeoutSec > maxTimeoutSec {
			return nil, protocol.BadRequest("超时必须是 1–86400 之间的整数秒")
		}
		task.TimeoutSec = *input.TimeoutSec
	}
	if overlap, ok := input.overlapValue(); ok {
		task.Overlap = overlap
	}
	if err := prepareTask(task); err != nil {
		return nil, err
	}
	task.NextRunAt = nextRunFor(task)

	m.mu.Lock()
	m.tasks[task.ID] = task
	m.scheduleLocked(task)
	err := m.saveTasksLocked()
	if err != nil {
		delete(m.tasks, task.ID)
		m.unscheduleLocked(task.ID)
		m.mu.Unlock()
		return nil, err
	}
	copied := task.clone()
	m.mu.Unlock()
	return copied, nil
}

func (m *Module) updateTask(id string, input taskInput) (*Task, error) {
	if !input.hasChanges() {
		return nil, protocol.BadRequest("至少需要修改一个字段")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.tasks[id]
	if current == nil {
		return nil, taskNotFound(id)
	}
	updated := current.clone()

	if input.Name.Set {
		if input.Name.Value == nil {
			return nil, protocol.BadRequest("任务名称不能为空")
		}
		updated.Name = *input.Name.Value
	}
	if input.Description.Set {
		updated.Description = optionalText(input.Description)
	}
	if input.Schedule.Set || input.Cron.Set {
		schedule, ok := input.scheduleValue()
		if !ok {
			return nil, protocol.BadRequest("cron 表达式不能为空")
		}
		updated.Schedule = schedule
	}
	if input.Timezone.Set {
		updated.Timezone = optionalText(input.Timezone)
	}
	if input.Command.Set {
		if input.Command.Value == nil {
			return nil, protocol.BadRequest("命令不能为空")
		}
		updated.Command = *input.Command.Value
	}
	if input.Cwd.Set {
		updated.Cwd = optionalText(input.Cwd)
	}
	if input.Env.Set {
		updated.Env = envValue(input.Env)
	}
	if input.Enabled != nil {
		updated.Enabled = *input.Enabled
	}
	if input.TimeoutSec != nil {
		if *input.TimeoutSec < 1 || *input.TimeoutSec > maxTimeoutSec {
			return nil, protocol.BadRequest("超时必须是 1–86400 之间的整数秒")
		}
		updated.TimeoutSec = *input.TimeoutSec
	}
	if overlap, ok := input.overlapValue(); ok {
		updated.Overlap = overlap
	} else if input.Overlap.Set || input.OverlapPolicy.Set {
		return nil, protocol.BadRequest("overlap 不能为空")
	}
	updated.UpdatedAt = nowString()
	if err := prepareTask(updated); err != nil {
		return nil, err
	}
	updated.NextRunAt = nextRunFor(updated)

	m.tasks[id] = updated
	m.scheduleLocked(updated)
	if err := m.saveTasksLocked(); err != nil {
		m.tasks[id] = current
		m.scheduleLocked(current)
		return nil, err
	}
	return updated.clone(), nil
}

func (m *Module) deleteTask(id string) (string, error) {
	m.mu.Lock()
	task := m.tasks[id]
	if task == nil {
		m.mu.Unlock()
		return "", taskNotFound(id)
	}
	delete(m.tasks, id)
	m.unscheduleLocked(id)
	killedRun := ""
	var runs []*activeRun
	for runID, run := range m.active[id] {
		if killedRun == "" {
			killedRun = runID
		}
		runs = append(runs, run)
	}
	delete(m.active, id)
	if err := m.saveTasksLocked(); err != nil {
		m.tasks[id] = task
		m.scheduleLocked(task)
		m.mu.Unlock()
		return "", err
	}
	m.mu.Unlock()
	for _, run := range runs {
		run.kill()
	}
	return killedRun, nil
}

func (m *Module) taskExists(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.tasks[id] != nil
}

/* -------------------------------- Execution ------------------------------ */

func (m *Module) startRun(id, triggeredBy string) (*TaskRun, error) {
	m.mu.Lock()
	task := m.tasks[id]
	if task == nil {
		m.mu.Unlock()
		return nil, taskNotFound(id)
	}
	now := nowString()
	if task.Overlap != overlapAllow && len(m.active[id]) > 0 {
		zero := int64(0)
		run := &TaskRun{TaskRunSummary: TaskRunSummary{
			ID:          "run_" + protocol.RandomID(9),
			TaskID:      id,
			Status:      statusSkipped,
			TriggeredBy: triggeredBy,
			StartedAt:   now,
			FinishedAt:  &now,
			DurationMs:  &zero,
		}}
		summary := run.TaskRunSummary
		task.LastRun = &summary
		_ = m.saveTasksLocked()
		copied := *run
		m.mu.Unlock()
		m.appendHistory(id, &copied)
		return &copied, nil
	}

	run := &TaskRun{TaskRunSummary: TaskRunSummary{
		ID:          "run_" + protocol.RandomID(9),
		TaskID:      id,
		Status:      statusRunning,
		TriggeredBy: triggeredBy,
		StartedAt:   now,
	}}
	summary := run.TaskRunSummary
	task.LastRun = &summary
	ctx, cancel := context.WithCancel(context.Background())
	active := &activeRun{run: run, cancel: cancel}
	if m.active[id] == nil {
		m.active[id] = make(map[string]*activeRun)
	}
	m.active[id][run.ID] = active
	snapshot := task.clone()
	_ = m.saveTasksLocked()
	copied := *run
	m.mu.Unlock()

	go m.executeRun(ctx, snapshot, run, active)
	return &copied, nil
}

func (m *Module) runScheduled(id string) {
	m.mu.Lock()
	task := m.tasks[id]
	if task == nil || !task.Enabled {
		m.mu.Unlock()
		return
	}
	task.NextRunAt = nextRunFor(task)
	_ = m.saveTasksLocked()
	m.mu.Unlock()
	_, _ = m.startRun(id, triggerSchedule)
}

// completeRun applies the outcome under the module lock, removes the active
// marker, updates lastRun/nextRunAt, then appends the history entry.
func (m *Module) completeRun(taskID string, run *TaskRun, result runResult) {
	finished := nowString()
	m.mu.Lock()
	run.Status = result.status
	run.FinishedAt = &finished
	run.ExitCode = result.exitCode
	run.DurationMs = &result.durationMs
	run.StdoutTail = result.stdoutTail
	run.StderrTail = result.stderrTail
	run.Truncated = result.truncated
	if set := m.active[taskID]; set != nil {
		delete(set, run.ID)
		if len(set) == 0 {
			delete(m.active, taskID)
		}
	}
	if task := m.tasks[taskID]; task != nil {
		summary := run.TaskRunSummary
		task.LastRun = &summary
		task.NextRunAt = nextRunFor(task)
		_ = m.saveTasksLocked()
	}
	m.mu.Unlock()
	m.appendHistory(taskID, run)
}

func (m *Module) scheduleLocked(task *Task) {
	if m.scheduler == nil || task == nil {
		return
	}
	m.unscheduleLocked(task.ID)
	if !task.Enabled {
		task.NextRunAt = nil
		return
	}
	schedule, err := parseSchedule(task.Schedule, task.location())
	if err != nil {
		task.NextRunAt = nil
		return
	}
	taskID := task.ID
	entryID := m.scheduler.Schedule(schedule, cron.FuncJob(func() { m.runScheduled(taskID) }))
	m.entries[task.ID] = entryID
	task.NextRunAt = nextRunFor(task)
}

func (m *Module) unscheduleLocked(id string) {
	if m.scheduler == nil {
		return
	}
	if entryID, ok := m.entries[id]; ok {
		m.scheduler.Remove(entryID)
		delete(m.entries, id)
	}
}

/* --------------------------------- History ------------------------------- */

func (m *Module) taskHistory(taskID, status string) []TaskRun {
	completed, _ := m.readHistory(taskID)
	completed = append(completed, m.activeRunCopies(taskID)...)
	filtered := filterRuns(completed, "", status)
	sortRunsDesc(filtered)
	return filtered
}

func (m *Module) allRuns(taskID, status string) []TaskRun {
	ids := make(map[string]struct{})
	m.mu.Lock()
	for id := range m.tasks {
		ids[id] = struct{}{}
	}
	active := make(map[string][]TaskRun)
	for id, runs := range m.active {
		for _, run := range runs {
			if run.run != nil {
				active[id] = append(active[id], *run.run)
			}
		}
		ids[id] = struct{}{}
	}
	m.mu.Unlock()

	entries, _ := os.ReadDir(m.historyDir())
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		ids[strings.TrimSuffix(name, ".jsonl")] = struct{}{}
	}

	runs := make([]TaskRun, 0, len(ids)*4)
	for id := range ids {
		if taskID != "" && id != taskID {
			continue
		}
		historical, _ := m.readHistory(id)
		runs = append(runs, historical...)
		runs = append(runs, active[id]...)
	}
	runs = filterRuns(runs, taskID, status)
	sortRunsDesc(runs)
	return runs
}

func (m *Module) activeRunCopies(taskID string) []TaskRun {
	m.mu.Lock()
	defer m.mu.Unlock()
	runs := make([]TaskRun, 0, len(m.active[taskID]))
	for _, run := range m.active[taskID] {
		if run.run != nil {
			runs = append(runs, *run.run)
		}
	}
	return runs
}

func filterRuns(runs []TaskRun, taskID, status string) []TaskRun {
	out := make([]TaskRun, 0, len(runs))
	for _, run := range runs {
		if taskID != "" && run.TaskID != taskID {
			continue
		}
		if status != "" && run.Status != status {
			continue
		}
		out = append(out, run)
	}
	return out
}

func sortRunsDesc(runs []TaskRun) {
	sort.Slice(runs, func(i, j int) bool {
		if runs[i].StartedAt == runs[j].StartedAt {
			return runs[i].ID > runs[j].ID
		}
		return runs[i].StartedAt > runs[j].StartedAt
	})
}

/* ------------------------------- Validation ------------------------------ */

func prepareTask(task *Task) error {
	task.Name = strings.TrimSpace(task.Name)
	if task.Name == "" {
		return protocol.BadRequest("任务名称不能为空")
	}
	if utf8.RuneCountInString(task.Name) > maxNameLen {
		return protocol.BadRequest("任务名称最长 120 个字符")
	}
	if task.Description != nil {
		trimmed := strings.TrimSpace(*task.Description)
		if trimmed == "" {
			task.Description = nil
		} else {
			if utf8.RuneCountInString(trimmed) > maxDescLen {
				return protocol.BadRequest("任务描述最长 2000 个字符")
			}
			task.Description = &trimmed
		}
	}
	if strings.TrimSpace(task.Command) == "" {
		return protocol.BadRequest("命令不能为空")
	}
	if len(task.Command) > maxCommandLen {
		return protocol.BadRequest("命令最长 64 KiB")
	}
	if task.Timezone != nil {
		raw := strings.TrimSpace(*task.Timezone)
		if raw == "" {
			task.Timezone = nil
			task.loc = time.Local
		} else {
			if len(raw) > 64 {
				return protocol.BadRequest("时区名称最长 64 个字符")
			}
			loc, err := loadLocation(raw)
			if err != nil {
				return protocol.BadRequest("时区不是合法的 IANA 名称: " + raw)
			}
			task.Timezone = &raw
			task.loc = loc
		}
	} else {
		task.loc = time.Local
	}
	task.Schedule = strings.TrimSpace(task.Schedule)
	if _, err := parseSchedule(task.Schedule, task.loc); err != nil {
		return &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "无效的 cron 表达式",
			Details: map[string]any{"error": err.Error()},
		}
	}
	if task.Cwd != nil {
		raw := strings.TrimSpace(*task.Cwd)
		if raw == "" {
			task.Cwd = nil
		} else {
			if len(raw) > maxCwdLen {
				return protocol.BadRequest("工作目录最长 4096 个字符")
			}
			absolute, err := filepath.Abs(raw)
			if err != nil {
				return protocol.BadRequest("工作目录不合法: " + raw)
			}
			info, err := os.Stat(absolute)
			if err != nil || !info.IsDir() {
				return protocol.BadRequest("工作目录不存在或不是目录: " + raw)
			}
			task.Cwd = &absolute
		}
	}
	env, err := sanitizeEnv(task.Env)
	if err != nil {
		return err
	}
	task.Env = env
	if task.TimeoutSec == 0 {
		task.TimeoutSec = defaultTimeoutSec
	}
	if task.TimeoutSec < 1 || task.TimeoutSec > maxTimeoutSec {
		return protocol.BadRequest("超时必须是 1–86400 之间的整数秒")
	}
	switch task.Overlap {
	case "", overlapSkip:
		task.Overlap = overlapSkip
	case overlapAllow:
		task.Overlap = overlapAllow
	default:
		return protocol.BadRequest("overlap 只能是 skip 或 allow")
	}
	return nil
}

func sanitizeEnv(env map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(env))
	for key, value := range env {
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, protocol.BadRequest("环境变量名不能为空")
		}
		if len(key) > 128 {
			return nil, protocol.BadRequest("环境变量名最长 128 个字符")
		}
		if hasControlOrEquals(key) {
			return nil, protocol.BadRequest("环境变量名不能包含“=”或控制字符")
		}
		if len(value) > maxEnvValue {
			return nil, protocol.BadRequest("环境变量值最长 4096 个字符: " + key)
		}
		if strings.ContainsRune(value, '\x00') {
			return nil, protocol.BadRequest("环境变量值包含非法字符: " + key)
		}
		if isDeniedEnv(key) {
			continue
		}
		out[key] = value
	}
	return out, nil
}

func hasControlOrEquals(value string) bool {
	for _, r := range value {
		if r == '=' || r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func isDeniedEnv(key string) bool {
	for _, denied := range deniedEnv {
		if strings.EqualFold(key, denied) {
			return true
		}
	}
	return false
}

func taskMatches(task *Task, query string) bool {
	if strings.Contains(strings.ToLower(task.Name), query) ||
		strings.Contains(strings.ToLower(task.Command), query) {
		return true
	}
	return task.Description != nil && strings.Contains(strings.ToLower(*task.Description), query)
}

func parseEnabledFilter(r *http.Request) (*bool, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("enabled"))
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return nil, protocol.BadRequest("enabled 查询参数必须是 true 或 false")
	}
	return &value, nil
}

func pageParams(r *http.Request) (int, string) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	return limit, r.URL.Query().Get("cursor")
}

func nextRunsCount(r *http.Request) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("count"))
	if raw == "" {
		return 5, nil
	}
	count, err := strconv.Atoi(raw)
	if err != nil || count < 1 || count > 10 {
		return 0, protocol.BadRequest("count 必须是 1–10 之间的整数")
	}
	return count, nil
}

func optionalText(value optString) *string {
	if !value.Set || value.Value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value.Value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func envValue(value optEnv) map[string]string {
	out := make(map[string]string)
	if value.Value == nil {
		return out
	}
	for key, item := range value.Value {
		out[key] = item
	}
	return out
}

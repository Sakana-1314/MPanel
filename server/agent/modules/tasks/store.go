package tasks

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/core/protocol"
)

func (m *Module) tasksPath() string {
	return filepath.Join(m.dataDir, "tasks.json")
}

func (m *Module) historyDir() string {
	return filepath.Join(m.dataDir, "tasks-history")
}

func (m *Module) historyPath(taskID string) string {
	return filepath.Join(m.historyDir(), taskID+".jsonl")
}

// loadTasks reads tasks.json and applies defaults for older/edited documents.
// It runs during Register before the scheduler starts, so no lock is needed.
func (m *Module) loadTasks() error {
	if m.dataDir == "" {
		return errors.New("tasks: 缺少 agent data dir")
	}
	if err := os.MkdirAll(m.dataDir, 0o755); err != nil {
		return err
	}
	data, err := os.ReadFile(m.tasksPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	var doc taskDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return errors.New("解析 tasks.json 失败: " + err.Error())
	}
	dirty := false
	for _, task := range doc.Tasks {
		if task == nil || strings.TrimSpace(task.ID) == "" {
			continue
		}
		normalizeTask(task)
		if task.LastRun != nil && task.LastRun.Status == statusRunning {
			// The agent restarted while a run was in flight; contract §12 says
			// such runs become failed.
			finished := nowString()
			duration := int64(0)
			task.LastRun.Status = statusFailed
			task.LastRun.FinishedAt = &finished
			task.LastRun.DurationMs = &duration
			dirty = true
		}
		task.NextRunAt = nextRunFor(task)
		m.tasks[task.ID] = task
	}
	if dirty {
		return m.saveTasksLocked()
	}
	return nil
}

func normalizeTask(task *Task) {
	if task.Env == nil {
		task.Env = map[string]string{}
	}
	if task.TimeoutSec <= 0 {
		task.TimeoutSec = defaultTimeoutSec
	}
	if task.TimeoutSec > maxTimeoutSec {
		task.TimeoutSec = maxTimeoutSec
	}
	if task.Overlap != overlapAllow {
		task.Overlap = overlapSkip
	}
	if task.CreatedAt == "" {
		task.CreatedAt = nowString()
	}
	if task.UpdatedAt == "" {
		task.UpdatedAt = task.CreatedAt
	}
	loc, err := loadLocation(valueOf(task.Timezone))
	if err != nil {
		task.Timezone = nil
		loc = time.Local
	}
	if task.Timezone != nil && strings.TrimSpace(*task.Timezone) == "" {
		task.Timezone = nil
	}
	task.loc = loc
}

func (m *Module) saveTasksLocked() error {
	all := make([]*Task, 0, len(m.tasks))
	for _, task := range m.tasks {
		all = append(all, task.clone())
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].CreatedAt == all[j].CreatedAt {
			return all[i].ID < all[j].ID
		}
		return all[i].CreatedAt < all[j].CreatedAt
	})
	data, err := json.MarshalIndent(taskDoc{Version: 1, Tasks: all}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeFileAtomic(m.tasksPath(), data, 0o600)
}

func (m *Module) appendHistory(taskID string, run *TaskRun) {
	if run == nil {
		return
	}
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	runs, err := m.readHistoryLocked(taskID)
	if err != nil {
		return
	}
	runs = append(runs, *run)
	if len(runs) > maxHistoryRuns {
		runs = runs[len(runs)-maxHistoryRuns:]
	}
	_ = m.writeHistoryLocked(taskID, runs)
}

func (m *Module) readHistory(taskID string) ([]TaskRun, error) {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	return m.readHistoryLocked(taskID)
}

func (m *Module) readHistoryLocked(taskID string) ([]TaskRun, error) {
	file, err := os.Open(m.historyPath(taskID))
	if errors.Is(err, os.ErrNotExist) {
		return []TaskRun{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	runs := make([]TaskRun, 0, maxHistoryRuns)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var run TaskRun
		if err := json.Unmarshal(line, &run); err != nil {
			continue // a torn line must not invalidate the rest of the history
		}
		runs = append(runs, run)
	}
	if err := scanner.Err(); err != nil {
		return runs, err
	}
	return runs, nil
}

func (m *Module) writeHistoryLocked(taskID string, runs []TaskRun) error {
	if len(runs) == 0 {
		err := os.Remove(m.historyPath(taskID))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var buf bytes.Buffer
	for _, run := range runs {
		line, err := json.Marshal(run)
		if err != nil {
			continue
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	return writeFileAtomic(m.historyPath(taskID), buf.Bytes(), 0o600)
}

func (m *Module) deleteHistory(taskID string) error {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	err := os.Remove(m.historyPath(taskID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".mpanel-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(perm); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

func nowString() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func valueOf(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func stringPtr(value string) *string {
	return &value
}

func nextRunFor(task *Task) *string {
	if task == nil || !task.Enabled {
		return nil
	}
	schedule, err := parseSchedule(task.Schedule, task.location())
	if err != nil {
		return nil
	}
	next := schedule.Next(time.Now())
	if next.IsZero() {
		return nil
	}
	formatted := next.In(task.location()).Format(time.RFC3339)
	return &formatted
}

// taskNotFound builds the standard 404 error.
func taskNotFound(id string) error {
	return protocol.NotFound("计划任务", id)
}

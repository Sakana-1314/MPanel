package tasks

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/internal/config"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

type testEnvelope struct {
	OK    bool               `json:"ok"`
	Data  json.RawMessage    `json:"data"`
	Error *protocol.APIError `json:"error"`
}

func newTestModule(t *testing.T) (*Module, *http.ServeMux, *config.Agent) {
	t.Helper()
	base := t.TempDir()
	cfg := &config.Agent{Agent: config.AgentSystem{
		BaseDir: base,
		DataDir: filepath.Join(base, "data"),
		Version: "test",
	}}
	mux := http.NewServeMux()
	module := New()
	ctx := &agent.Context{
		Mux:    mux,
		WS:     agent.NewWSRegistry(),
		Cfg:    cfg,
		Runner: agent.NewRunner(),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if err := module.Register(ctx); err != nil {
		t.Fatalf("Register: %v", err)
	}
	t.Cleanup(module.Close)
	return module, mux, cfg
}

func doJSON(t *testing.T, mux *http.ServeMux, method, target string, body any) (int, testEnvelope) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	var envelope testEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode %s %s response %q: %v", method, target, recorder.Body.String(), err)
	}
	return recorder.Code, envelope
}

func createEchoTask(t *testing.T, mux *http.ServeMux) Task {
	t.Helper()
	status, envelope := doJSON(t, mux, http.MethodPost, "/api/v1/tasks", map[string]any{
		"name":       "echo task",
		"schedule":   "*/5 * * * *",
		"command":    "echo mpanel-task-ok",
		"timeoutSec": 10,
	})
	if status != http.StatusCreated || !envelope.OK {
		t.Fatalf("create task status=%d error=%+v", status, envelope.Error)
	}
	var task Task
	if err := json.Unmarshal(envelope.Data, &task); err != nil {
		t.Fatalf("decode task: %v", err)
	}
	return task
}

func TestCronValidationAndNextRuns(t *testing.T) {
	times, err := nextRunTimes("*/5 * * * *", time.UTC, 5)
	if err != nil {
		t.Fatalf("nextRunTimes: %v", err)
	}
	if len(times) != 5 {
		t.Fatalf("expected 5 runs, got %d", len(times))
	}
	previous := time.Time{}
	for _, raw := range times {
		at, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		if !at.After(time.Now().Add(-time.Second)) {
			t.Fatalf("next run %s is not in the future", raw)
		}
		if !previous.IsZero() && !at.After(previous) {
			t.Fatalf("next runs are not ascending: %s then %s", previous, at)
		}
		previous = at
		if at.Minute()%5 != 0 {
			t.Fatalf("run %s is not aligned to */5", raw)
		}
	}
	if _, err := parseSchedule("* * *", time.UTC); err == nil {
		t.Fatal("3-field expression should be rejected")
	}
	if _, err := parseSchedule("0 0 0 * * *", time.UTC); err == nil {
		t.Fatal("6-field expression should be rejected")
	}
	if shanghai, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		times, err := nextRunTimes("0 9 * * *", shanghai, 3)
		if err != nil {
			t.Fatalf("timezone nextRunTimes: %v", err)
		}
		for _, raw := range times {
			at, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				t.Fatalf("parse %q: %v", raw, err)
			}
			if hour := at.In(shanghai).Hour(); hour != 9 {
				t.Fatalf("expected 09:00 in Asia/Shanghai, got %s", raw)
			}
		}
	}

	_, mux, _ := newTestModule(t)
	target := "/api/v1/tasks/next-runs?cron=" + url.QueryEscape("0 9 * * *") + "&count=3"
	status, envelope := doJSON(t, mux, http.MethodGet, target, nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("next-runs status=%d error=%+v", status, envelope.Error)
	}
	var result struct {
		NextRuns []struct {
			At string `json:"at"`
		} `json:"nextRuns"`
	}
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatalf("decode next-runs: %v", err)
	}
	if len(result.NextRuns) != 3 {
		t.Fatalf("expected 3 next runs, got %+v", result.NextRuns)
	}

	status, _ = doJSON(t, mux, http.MethodGet, "/api/v1/tasks/next-runs?cron=not-a-cron", nil)
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid cron, got %d", status)
	}
}

func TestTaskCRUDAndRunNow(t *testing.T) {
	_, mux, cfg := newTestModule(t)
	task := createEchoTask(t, mux)

	if task.ID == "" || !task.Enabled || task.Overlap != overlapSkip || task.TimeoutSec != 10 {
		t.Fatalf("unexpected created task: %+v", task)
	}
	if task.NextRunAt == nil {
		t.Fatal("enabled task should have nextRunAt")
	}
	if task.Description != nil || task.Timezone != nil || task.Cwd != nil {
		t.Fatalf("unexpected optional fields: %+v", task)
	}

	status, envelope := doJSON(t, mux, http.MethodGet, "/api/v1/tasks", nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("list status=%d error=%+v", status, envelope.Error)
	}
	var list protocol.ListResult[Task]
	if err := json.Unmarshal(envelope.Data, &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].ID != task.ID {
		t.Fatalf("unexpected list: %+v", list.Items)
	}

	status, envelope = doJSON(t, mux, http.MethodPatch, "/api/v1/tasks/"+task.ID, map[string]any{
		"name":    "renamed task",
		"enabled": false,
	})
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("patch status=%d error=%+v", status, envelope.Error)
	}
	var patched Task
	if err := json.Unmarshal(envelope.Data, &patched); err != nil {
		t.Fatalf("decode patched: %v", err)
	}
	if patched.Name != "renamed task" || patched.Enabled || patched.NextRunAt != nil {
		t.Fatalf("unexpected patched task: %+v", patched)
	}

	// PUT is the contract's primary update method; PATCH is accepted too.
	status, envelope = doJSON(t, mux, http.MethodPut, "/api/v1/tasks/"+task.ID, map[string]any{
		"enabled": true,
	})
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("put status=%d error=%+v", status, envelope.Error)
	}
	var updated Task
	if err := json.Unmarshal(envelope.Data, &updated); err != nil {
		t.Fatalf("decode updated: %v", err)
	}
	if !updated.Enabled || updated.NextRunAt == nil {
		t.Fatalf("expected enabled task with nextRunAt: %+v", updated)
	}

	status, envelope = doJSON(t, mux, http.MethodPost, "/api/v1/tasks/"+task.ID+"/run", map[string]any{})
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("run status=%d error=%+v", status, envelope.Error)
	}
	var runNow struct {
		Run TaskRun `json:"run"`
	}
	if err := json.Unmarshal(envelope.Data, &runNow); err != nil {
		t.Fatalf("decode run-now: %v", err)
	}
	if runNow.Run.ID == "" || runNow.Run.TaskID != task.ID {
		t.Fatalf("unexpected run-now result: %+v", runNow.Run)
	}
	if runNow.Run.Status != statusRunning {
		t.Fatalf("run-now should return immediately with running, got %s", runNow.Run.Status)
	}

	finished := waitForRun(t, mux, task.ID, runNow.Run.ID)
	if finished.Status != statusSuccess {
		t.Fatalf("expected success, got %+v (stderr=%q)", finished, finished.StderrTail)
	}
	if finished.ExitCode == nil || *finished.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %+v", finished.ExitCode)
	}
	if !contains(finished.StdoutTail, "mpanel-task-ok") {
		t.Fatalf("stdout tail missing marker: %q", finished.StdoutTail)
	}
	if finished.FinishedAt == nil || finished.DurationMs == nil {
		t.Fatalf("finished run missing timestamps: %+v", finished)
	}

	status, envelope = doJSON(t, mux, http.MethodGet, "/api/v1/tasks/"+task.ID+"/next-runs?count=2", nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("task next-runs status=%d error=%+v", status, envelope.Error)
	}
	var next struct {
		NextRuns []struct {
			At string `json:"at"`
		} `json:"nextRuns"`
	}
	if err := json.Unmarshal(envelope.Data, &next); err != nil || len(next.NextRuns) != 2 {
		t.Fatalf("unexpected task next-runs: %+v err=%v", next, err)
	}

	status, envelope = doJSON(t, mux, http.MethodDelete, "/api/v1/tasks/"+task.ID, nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("delete status=%d error=%+v", status, envelope.Error)
	}
	var deleted struct {
		Deleted bool   `json:"deleted"`
		ID      string `json:"id"`
	}
	if err := json.Unmarshal(envelope.Data, &deleted); err != nil || !deleted.Deleted || deleted.ID != task.ID {
		t.Fatalf("unexpected delete result: %+v err=%v", deleted, err)
	}

	status, _ = doJSON(t, mux, http.MethodGet, "/api/v1/tasks/"+task.ID, nil)
	if status != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", status)
	}

	historyPath := filepath.Join(cfg.Agent.DataDir, "tasks-history", task.ID+".jsonl")
	if _, err := os.Stat(historyPath); err != nil {
		t.Fatalf("history file should be retained after delete: %v", err)
	}
	status, envelope = doJSON(t, mux, http.MethodGet, "/api/v1/tasks/runs?taskId="+task.ID, nil)
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("all runs status=%d error=%+v", status, envelope.Error)
	}
	var runs protocol.ListResult[TaskRun]
	if err := json.Unmarshal(envelope.Data, &runs); err != nil || len(runs.Items) == 0 {
		t.Fatalf("deleted task history should remain visible in /tasks/runs: %+v err=%v", runs, err)
	}
}

func TestOverlapSkipCreatesSkippedRun(t *testing.T) {
	module, mux, _ := newTestModule(t)
	task := createEchoTask(t, mux)

	module.mu.Lock()
	module.active[task.ID] = map[string]*activeRun{
		"run_fake": {run: &TaskRun{TaskRunSummary: TaskRunSummary{ID: "run_fake", TaskID: task.ID, Status: statusRunning}}},
	}
	module.mu.Unlock()

	run, err := module.startRun(task.ID, triggerManual)
	if err != nil {
		t.Fatalf("startRun: %v", err)
	}
	if run.Status != statusSkipped {
		t.Fatalf("expected skipped under overlap=skip, got %+v", run)
	}
	if run.FinishedAt == nil {
		t.Fatal("skipped run should be finished immediately")
	}

	status, _ := doJSON(t, mux, http.MethodDelete, "/api/v1/tasks/"+task.ID, nil)
	if status != http.StatusOK {
		t.Fatalf("cleanup delete failed: %d", status)
	}
}

func TestHistoryRetentionKeepsFifty(t *testing.T) {
	module, _, _ := newTestModule(t)
	for i := 0; i < 55; i++ {
		run := &TaskRun{TaskRunSummary: TaskRunSummary{
			ID:        "run_" + time.Now().Format("150405.000000000") + string(rune('a'+i%26)),
			TaskID:    "task_history",
			Status:    statusSuccess,
			StartedAt: nowString(),
		}}
		module.appendHistory("task_history", run)
	}
	runs, err := module.readHistory("task_history")
	if err != nil {
		t.Fatalf("readHistory: %v", err)
	}
	if len(runs) != maxHistoryRuns {
		t.Fatalf("expected %d retained runs, got %d", maxHistoryRuns, len(runs))
	}
}

func TestTaskValidation(t *testing.T) {
	_, mux, _ := newTestModule(t)

	status, _ := doJSON(t, mux, http.MethodPost, "/api/v1/tasks", map[string]any{
		"name":     "bad cron",
		"schedule": "nope",
		"command":  "echo hi",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad cron, got %d", status)
	}

	status, _ = doJSON(t, mux, http.MethodPost, "/api/v1/tasks", map[string]any{
		"name":     "bad tz",
		"schedule": "* * * * *",
		"command":  "echo hi",
		"timezone": "Mars/Olympus",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad timezone, got %d", status)
	}

	status, _ = doJSON(t, mux, http.MethodPost, "/api/v1/tasks", map[string]any{
		"name":     "missing command",
		"schedule": "* * * * *",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing command, got %d", status)
	}
}

func TestTaskOptionalFieldsAndEnvSanitization(t *testing.T) {
	_, mux, cfg := newTestModule(t)
	status, envelope := doJSON(t, mux, http.MethodPost, "/api/v1/tasks", map[string]any{
		"name":        "optional fields",
		"description": "  description  ",
		"schedule":    "0 9 * * *",
		"timezone":    "UTC",
		"command":     "echo hi",
		"cwd":         cfg.Agent.BaseDir,
		"env": map[string]string{
			"KEEP":         "1",
			"MPANEL_TOKEN": "must-not-survive",
		},
	})
	if status != http.StatusCreated || !envelope.OK {
		t.Fatalf("create status=%d error=%+v", status, envelope.Error)
	}
	var task Task
	if err := json.Unmarshal(envelope.Data, &task); err != nil {
		t.Fatalf("decode task: %v", err)
	}
	if task.Description == nil || *task.Description != "description" {
		t.Fatalf("description not trimmed: %+v", task.Description)
	}
	if task.Timezone == nil || *task.Timezone != "UTC" {
		t.Fatalf("timezone missing: %+v", task.Timezone)
	}
	if task.Cwd == nil || *task.Cwd != cfg.Agent.BaseDir {
		t.Fatalf("cwd missing: %+v", task.Cwd)
	}
	if task.Env["KEEP"] != "1" {
		t.Fatalf("env value missing: %+v", task.Env)
	}
	if _, exists := task.Env["MPANEL_TOKEN"]; exists {
		t.Fatalf("panel credential leaked into task env: %+v", task.Env)
	}

	status, envelope = doJSON(t, mux, http.MethodPatch, "/api/v1/tasks/"+task.ID, map[string]any{
		"description": nil,
		"timezone":    nil,
		"cwd":         nil,
		"env":         nil,
	})
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("clear status=%d error=%+v", status, envelope.Error)
	}
	var cleared Task
	if err := json.Unmarshal(envelope.Data, &cleared); err != nil {
		t.Fatalf("decode cleared: %v", err)
	}
	if cleared.Description != nil || cleared.Timezone != nil || cleared.Cwd != nil {
		t.Fatalf("optional fields not cleared: %+v", cleared)
	}
	if len(cleared.Env) != 0 {
		t.Fatalf("env not cleared: %+v", cleared.Env)
	}

	status, _ = doJSON(t, mux, http.MethodPatch, "/api/v1/tasks/"+task.ID, map[string]any{"timeoutSec": 0})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for timeoutSec=0, got %d", status)
	}
	status, _ = doJSON(t, mux, http.MethodPatch, "/api/v1/tasks/"+task.ID, map[string]any{"overlap": nil})
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for overlap=null, got %d", status)
	}
}

func TestTaskCommandHonorsCwdAndEnv(t *testing.T) {
	_, mux, cfg := newTestModule(t)
	command := `printf '%s\n' "$MPANEL_TEST_VALUE"; pwd`
	if runtime.GOOS == "windows" {
		command = `echo %MPANEL_TEST_VALUE% & cd`
	}
	status, envelope := doJSON(t, mux, http.MethodPost, "/api/v1/tasks", map[string]any{
		"name":     "cwd and env",
		"schedule": "*/5 * * * *",
		"command":  command,
		"cwd":      cfg.Agent.BaseDir,
		"env":      map[string]string{"MPANEL_TEST_VALUE": "env-marker"},
	})
	if status != http.StatusCreated || !envelope.OK {
		t.Fatalf("create status=%d error=%+v", status, envelope.Error)
	}
	var task Task
	if err := json.Unmarshal(envelope.Data, &task); err != nil {
		t.Fatalf("decode task: %v", err)
	}
	status, envelope = doJSON(t, mux, http.MethodPost, "/api/v1/tasks/"+task.ID+"/run", map[string]any{})
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("run status=%d error=%+v", status, envelope.Error)
	}
	var runNow struct {
		Run TaskRun `json:"run"`
	}
	if err := json.Unmarshal(envelope.Data, &runNow); err != nil {
		t.Fatalf("decode run-now: %v", err)
	}
	finished := waitForRun(t, mux, task.ID, runNow.Run.ID)
	if finished.Status != statusSuccess {
		t.Fatalf("expected success, got %+v (stderr=%q)", finished, finished.StderrTail)
	}
	if !strings.Contains(finished.StdoutTail, "env-marker") {
		t.Fatalf("env was not applied: %q", finished.StdoutTail)
	}
	if !strings.Contains(strings.ToLower(finished.StdoutTail), strings.ToLower(cfg.Agent.BaseDir)) {
		t.Fatalf("cwd was not applied: %q (want %q)", finished.StdoutTail, cfg.Agent.BaseDir)
	}
}

func TestTaskTimeoutKillsRun(t *testing.T) {
	_, mux, _ := newTestModule(t)
	command := "sleep 5"
	if runtime.GOOS == "windows" {
		command = "ping -n 10 127.0.0.1 > nul"
	}
	status, envelope := doJSON(t, mux, http.MethodPost, "/api/v1/tasks", map[string]any{
		"name":       "timeout",
		"schedule":   "*/5 * * * *",
		"command":    command,
		"timeoutSec": 1,
	})
	if status != http.StatusCreated || !envelope.OK {
		t.Fatalf("create status=%d error=%+v", status, envelope.Error)
	}
	var task Task
	if err := json.Unmarshal(envelope.Data, &task); err != nil {
		t.Fatalf("decode task: %v", err)
	}
	status, envelope = doJSON(t, mux, http.MethodPost, "/api/v1/tasks/"+task.ID+"/run", map[string]any{})
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("run status=%d error=%+v", status, envelope.Error)
	}
	var runNow struct {
		Run TaskRun `json:"run"`
	}
	if err := json.Unmarshal(envelope.Data, &runNow); err != nil {
		t.Fatalf("decode run-now: %v", err)
	}
	finished := waitForRun(t, mux, task.ID, runNow.Run.ID)
	if finished.Status != statusTimeout {
		t.Fatalf("expected timeout, got %+v (stderr=%q)", finished, finished.StderrTail)
	}
	if finished.DurationMs == nil || *finished.DurationMs > 10_000 {
		t.Fatalf("timeout duration looks wrong: %+v", finished.DurationMs)
	}
}

func TestTaskPersistsAcrossReload(t *testing.T) {
	first, mux, cfg := newTestModule(t)
	task := createEchoTask(t, mux)
	first.Close()

	second := New()
	ctx := &agent.Context{
		Mux:    http.NewServeMux(),
		WS:     agent.NewWSRegistry(),
		Cfg:    cfg,
		Runner: agent.NewRunner(),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if err := second.Register(ctx); err != nil {
		t.Fatalf("second Register: %v", err)
	}
	t.Cleanup(second.Close)
	second.mu.Lock()
	loaded := second.tasks[task.ID]
	second.mu.Unlock()
	if loaded == nil || loaded.Name != task.Name || loaded.Schedule != task.Schedule {
		t.Fatalf("task did not survive reload: %+v", loaded)
	}
}

func waitForRun(t *testing.T, mux *http.ServeMux, taskID, runID string) TaskRun {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last TaskRun
	for time.Now().Before(deadline) {
		status, envelope := doJSON(t, mux, http.MethodGet, "/api/v1/tasks/"+taskID+"/history", nil)
		if status == http.StatusOK && envelope.OK {
			var list protocol.ListResult[TaskRun]
			if err := json.Unmarshal(envelope.Data, &list); err == nil {
				for _, run := range list.Items {
					if run.ID == runID {
						last = run
						if run.Status != statusRunning {
							return run
						}
					}
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("run %s did not finish; last=%+v", runID, last)
	return last
}

func contains(value, needle string) bool {
	return len(value) >= len(needle) && bytes.Contains([]byte(value), []byte(needle))
}

package tasks

import (
	"encoding/json"
	"strings"
	"time"
)

// Task statuses, trigger sources and overlap policies mirror contract §12.
const (
	statusRunning = "running"
	statusSuccess = "success"
	statusFailed  = "failed"
	statusTimeout = "timeout"
	statusSkipped = "skipped"

	triggerSchedule = "schedule"
	triggerManual   = "manual"

	overlapSkip  = "skip"
	overlapAllow = "allow"

	defaultTimeoutSec = 300
	maxTimeoutSec     = 86400
	maxHistoryRuns    = 50
	maxTailBytes      = 4 * 1024

	maxNameLen    = 120
	maxDescLen    = 2000
	maxCommandLen = 65536
	maxCwdLen     = 4096
	maxEnvValue   = 4096
)

// deniedEnv are panel credentials removed from every task (and terminal)
// process environment.
var deniedEnv = []string{
	"MPANEL_TOKEN",
	"MPANEL_SECRET_KEY",
	"MPANEL_CORE_TOKEN",
	"MPANEL_MACHINE_SECRET",
}

// Task is the API/persistence shape of a scheduled task.
type Task struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description *string           `json:"description"`
	Schedule    string            `json:"schedule"`
	Timezone    *string           `json:"timezone"`
	Command     string            `json:"command"`
	Cwd         *string           `json:"cwd"`
	Env         map[string]string `json:"env"`
	Enabled     bool              `json:"enabled"`
	TimeoutSec  int               `json:"timeoutSec"`
	Overlap     string            `json:"overlap"`
	CreatedAt   string            `json:"createdAt"`
	UpdatedAt   string            `json:"updatedAt"`
	NextRunAt   *string           `json:"nextRunAt"`
	LastRun     *TaskRunSummary   `json:"lastRun"`

	loc *time.Location
}

// TaskRunSummary is the compact run view embedded in Task.lastRun.
type TaskRunSummary struct {
	ID          string  `json:"id"`
	TaskID      string  `json:"taskId"`
	Status      string  `json:"status"`
	TriggeredBy string  `json:"triggeredBy"`
	StartedAt   string  `json:"startedAt"`
	FinishedAt  *string `json:"finishedAt"`
	ExitCode    *int    `json:"exitCode"`
	DurationMs  *int64  `json:"durationMs"`
}

// TaskRun is one history entry with the captured output tails.
type TaskRun struct {
	TaskRunSummary
	StdoutTail string  `json:"stdoutTail"`
	StderrTail string  `json:"stderrTail"`
	Truncated  bool    `json:"truncated"`
	LogPath    *string `json:"logPath,omitempty"`
}

type taskDoc struct {
	Version int     `json:"version"`
	Tasks   []*Task `json:"tasks"`
}

func (t *Task) clone() *Task {
	if t == nil {
		return nil
	}
	copied := *t
	if t.Env != nil {
		copied.Env = make(map[string]string, len(t.Env))
		for key, value := range t.Env {
			copied.Env[key] = value
		}
	}
	return &copied
}

func (t *Task) location() *time.Location {
	if t.loc != nil {
		return t.loc
	}
	return time.Local
}

func (t *Task) summary(run *TaskRun) *TaskRunSummary {
	if run == nil {
		return nil
	}
	summary := run.TaskRunSummary
	return &summary
}

// taskInput is used by both POST /tasks and PUT|PATCH /tasks/{id}. Optional
// fields track presence so an explicit null can clear description/timezone/cwd
// while an omitted field stays untouched.
type taskInput struct {
	Name          optString `json:"name"`
	Description   optString `json:"description"`
	Schedule      optString `json:"schedule"`
	Cron          optString `json:"cron"`
	Timezone      optString `json:"timezone"`
	Command       optString `json:"command"`
	Cwd           optString `json:"cwd"`
	Env           optEnv    `json:"env"`
	Enabled       *bool     `json:"enabled"`
	TimeoutSec    *int      `json:"timeoutSec"`
	Overlap       optString `json:"overlap"`
	OverlapPolicy optString `json:"overlapPolicy"`
}

func (in taskInput) hasChanges() bool {
	return in.Name.Set || in.Description.Set || in.Schedule.Set || in.Cron.Set ||
		in.Timezone.Set || in.Command.Set || in.Cwd.Set || in.Env.Set ||
		in.Enabled != nil || in.TimeoutSec != nil || in.Overlap.Set || in.OverlapPolicy.Set
}

// scheduleValue returns the schedule field, accepting the contract's
// "schedule" name and the shorter "cron" alias.
func (in taskInput) scheduleValue() (string, bool) {
	if in.Schedule.Set {
		if in.Schedule.Value == nil {
			return "", false
		}
		return *in.Schedule.Value, true
	}
	if in.Cron.Set && in.Cron.Value != nil {
		return *in.Cron.Value, true
	}
	return "", false
}

// overlapValue normalises "overlap" and the "overlapPolicy" alias. "forbid" is
// accepted as a synonym of the contract's "skip".
func (in taskInput) overlapValue() (string, bool) {
	raw := ""
	ok := false
	if in.Overlap.Set && in.Overlap.Value != nil {
		raw, ok = *in.Overlap.Value, true
	} else if in.OverlapPolicy.Set && in.OverlapPolicy.Value != nil {
		raw, ok = *in.OverlapPolicy.Value, true
	}
	if !ok {
		return "", false
	}
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "forbid" {
		raw = overlapSkip
	}
	return raw, true
}

type optString struct {
	Set   bool
	Value *string
}

func (o *optString) UnmarshalJSON(data []byte) error {
	o.Set = true
	if strings.TrimSpace(string(data)) == "null" {
		o.Value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

type optEnv struct {
	Set   bool
	Value map[string]string
}

func (o *optEnv) UnmarshalJSON(data []byte) error {
	o.Set = true
	if strings.TrimSpace(string(data)) == "null" {
		o.Value = nil
		return nil
	}
	var value map[string]string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = value
	return nil
}

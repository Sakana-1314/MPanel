package tasks

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/sakana-1314/mpanel/server/agent"
)

// shellSpec is the resolved task shell command prefix.
type shellSpec struct {
	name string
	args []string
}

// activeRun tracks the kill handles and initial run record of an in-flight run.
type activeRun struct {
	mu      sync.Mutex
	run     *TaskRun
	pidFile string
	cancel  context.CancelFunc
}

func (a *activeRun) setPIDFile(path string) {
	a.mu.Lock()
	a.pidFile = path
	a.mu.Unlock()
}

// kill terminates the run's process tree (when the shell already published its
// pid) and cancels the runner call. It is safe to call multiple times.
func (a *activeRun) kill() {
	a.mu.Lock()
	pidFile := a.pidFile
	cancel := a.cancel
	a.mu.Unlock()
	if pidFile != "" {
		if pid := readPIDFile(pidFile); pid > 0 {
			_ = killProcessTree(pid)
		}
	}
	if cancel != nil {
		cancel()
	}
}

func resolveTaskShell() shellSpec {
	if raw := strings.TrimSpace(os.Getenv("MPANEL_TASK_SHELL")); raw != "" {
		if parts := strings.Fields(raw); len(parts) > 0 {
			if len(parts) == 1 {
				base := strings.ToLower(filepath.Base(parts[0]))
				switch {
				case runtime.GOOS == "windows" && (base == "cmd" || base == "cmd.exe"):
					return shellSpec{name: parts[0], args: []string{"/c"}}
				case runtime.GOOS == "windows" && strings.HasPrefix(base, "powershell"):
					return shellSpec{name: parts[0], args: []string{"-Command"}}
				case runtime.GOOS != "windows":
					return shellSpec{name: parts[0], args: []string{"-lc"}}
				}
			}
			return shellSpec{name: parts[0], args: parts[1:]}
		}
	}
	if runtime.GOOS == "windows" {
		return shellSpec{name: "cmd.exe", args: []string{"/c"}}
	}
	if _, err := os.Stat("/bin/sh"); err == nil {
		return shellSpec{name: "/bin/sh", args: []string{"-lc"}}
	}
	return shellSpec{name: "sh", args: []string{"-lc"}}
}

// runResult is the outcome applied to a run record under the module lock.
type runResult struct {
	status     string
	exitCode   *int
	durationMs int64
	stdoutTail string
	stderrTail string
	truncated  bool
}

// executeRun runs one task command. It is started in a goroutine by startRun.
func (m *Module) executeRun(ctx context.Context, task *Task, run *TaskRun, ar *activeRun) {
	start := time.Now()
	res, timedOut, err := m.runCommand(ctx, task, run.ID, ar)
	duration := time.Since(start).Milliseconds()

	stdoutTail, stdoutCut := tailOutput(res.Stdout)
	stderrTail, stderrCut := tailOutput(res.Stderr)

	result := runResult{
		status:     statusSuccess,
		durationMs: duration,
		stdoutTail: stdoutTail,
		stderrTail: stderrTail,
		truncated:  stdoutCut || stderrCut,
	}
	switch {
	case timedOut:
		result.status = statusTimeout
	case err != nil || ctx.Err() != nil:
		result.status = statusFailed
		message := err
		if message == nil {
			message = ctx.Err()
		}
		if strings.TrimSpace(result.stderrTail) == "" {
			result.stderrTail = message.Error()
		} else {
			result.stderrTail = tailOnly(strings.TrimSpace(result.stderrTail)+"\n"+message.Error(), maxTailBytes)
		}
		code := res.Code
		result.exitCode = &code
	default:
		code := res.Code
		result.exitCode = &code
		if code != 0 {
			result.status = statusFailed
		}
	}
	if timedOut {
		result.exitCode = nil
	}
	m.completeRun(task.ID, run, result)
}

func (m *Module) runCommand(ctx context.Context, task *Task, runID string, ar *activeRun) (agent.Result, bool, error) {
	m.mu.Lock()
	runner := m.runner
	m.mu.Unlock()
	if runner == nil {
		return agent.Result{}, false, errors.New("命令执行器未就绪")
	}
	if err := ctx.Err(); err != nil {
		return agent.Result{}, false, err
	}

	pidFile := filepath.Join(m.dataDir, "tmp", "task-"+runID+".pid")
	if err := os.MkdirAll(filepath.Dir(pidFile), 0o755); err != nil {
		return agent.Result{}, false, err
	}
	defer func() { _ = os.Remove(pidFile) }()

	name, args, err := buildInvocation(resolveTaskShell(), task, pidFile)
	if err != nil {
		return agent.Result{}, false, err
	}
	ar.setPIDFile(pidFile)

	timeout := time.Duration(task.TimeoutSec) * time.Second
	if timeout <= 0 {
		timeout = defaultTimeoutSec * time.Second
	}
	const grace = 3 * time.Second

	type outcome struct {
		res agent.Result
		err error
	}
	done := make(chan outcome, 1)
	runCtx, cancel := context.WithTimeout(ctx, timeout+grace)
	defer cancel()
	go func() {
		res, err := runner.RunTimeout(runCtx, timeout+grace, name, args...)
		done <- outcome{res: res, err: err}
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-done:
		return result.res, false, result.err
	case <-timer.C:
		// The runner's own context would only kill the direct child; kill the
		// process tree recorded by the wrapper script first.
		if pid := readPIDFile(pidFile); pid > 0 {
			_ = killProcessTree(pid)
		}
		result := <-done
		return result.res, true, result.err
	}
}

func readPIDFile(path string) int {
	for attempt := 0; attempt < 5; attempt++ {
		data, err := os.ReadFile(path)
		if err == nil {
			if pid, convErr := strconv.Atoi(strings.TrimSpace(string(data))); convErr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return 0
}

// tailOutput keeps the last maxTailBytes of s. The cut is advanced past a
// UTF-8 continuation byte so the JSON string stays valid.
func tailOutput(s string) (string, bool) {
	if len(s) <= maxTailBytes {
		return s, false
	}
	return tailOnly(s, maxTailBytes), true
}

func tailOnly(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	b := []byte(s)[len(s)-limit:]
	for len(b) > 0 && !utf8.RuneStart(b[0]) {
		b = b[1:]
	}
	return string(b)
}

func sortedKeys(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

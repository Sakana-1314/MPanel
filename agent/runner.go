package agent

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os/exec"
	"sync"
	"time"
)

// MaxCommandOutput caps captured stdout/stderr per command (8 MiB).
const MaxCommandOutput = 8 << 20

// execRunner is the default Runner backed by os/exec with argument arrays.
type execRunner struct{}

// NewRunner returns the default command runner.
func NewRunner() Runner { return execRunner{} }

// Run executes a command with a 60s default timeout.
func (r execRunner) Run(ctx context.Context, name string, args ...string) (Result, error) {
	return r.RunTimeout(ctx, 60*time.Second, name, args...)
}

// RunTimeout executes a command with a timeout. A non-zero exit is returned as
// a Result with no error; only spawn failures and timeouts produce an error.
func (r execRunner) RunTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr limitedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if err == nil {
		return res, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		res.Code = exitErr.ExitCode()
		return res, nil
	}
	if ctx.Err() == context.DeadlineExceeded {
		return res, errors.New("命令执行超时")
	}
	return res, err
}

// Stream executes a command and calls onLine for each stdout line.
func (r execRunner) Stream(ctx context.Context, name string, args []string, onLine func(string)) (Result, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, err
	}
	var stderr limitedBuffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return Result{}, err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	for scanner.Scan() {
		onLine(scanner.Text())
	}
	waitErr := cmd.Wait()
	res := Result{Stderr: stderr.String()}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			res.Code = exitErr.ExitCode()
			return res, nil
		}
		return res, waitErr
	}
	return res, nil
}

// limitedBuffer caps captured output while still draining the pipe.
type limitedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buf.Len() < MaxCommandOutput {
		remaining := MaxCommandOutput - b.buf.Len()
		if len(p) > remaining {
			b.buf.Write(p[:remaining])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

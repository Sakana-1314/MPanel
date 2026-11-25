//go:build windows

package terminal

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
)

// process is the Windows fallback: pipes instead of a PTY. resize is a no-op
// and the session reports pty:false.
type process struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *os.File

	closeOnce sync.Once
}

func startProcess(spec processSpec) (*process, error) {
	cmd := exec.Command(spec.shell)
	cmd.Dir = spec.cwd
	cmd.Env = spec.env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	cmd.Stdout = writer
	cmd.Stderr = writer
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = reader.Close()
		_ = writer.Close()
		return nil, err
	}
	// The child owns the write end; the parent must close its copy or reads
	// never observe EOF.
	_ = writer.Close()
	return &process{cmd: cmd, stdin: stdin, out: reader}, nil
}

func (p *process) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *process) Write(b []byte) (int, error) { return p.stdin.Write(b) }

// Resize is a no-op without a PTY; callers still get an accurate cols/rows in
// the session description.
func (p *process) Resize(cols, rows uint16) error { return nil }

func (p *process) IsPTY() bool { return false }

func (p *process) Wait() (*int, string, error) {
	err := p.cmd.Wait()
	if err == nil {
		code := 0
		return &code, "", nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		code := exitErr.ExitCode()
		return &code, "", nil
	}
	return nil, "", err
}

// Kill takes the whole process tree down: taskkill /T covers children spawned
// by cmd.exe / powershell.exe, which a plain Process.Kill would orphan.
func (p *process) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.cmd.Process.Pid)).Run()
	return p.cmd.Process.Kill()
}

func (p *process) Close() error {
	var err error
	p.closeOnce.Do(func() {
		if p.stdin != nil {
			_ = p.stdin.Close()
		}
		if p.out != nil {
			err = p.out.Close()
		}
	})
	return err
}

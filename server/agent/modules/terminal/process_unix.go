//go:build linux || darwin || freebsd

package terminal

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

// process is a real PTY-backed shell on Unix.
type process struct {
	cmd  *exec.Cmd
	ptmx *os.File

	closeOnce sync.Once
}

func startProcess(spec processSpec) (*process, error) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(spec.shell)
	cmd.Dir = spec.cwd
	cmd.Env = spec.env
	cmd.Stdin = tty
	cmd.Stdout = tty
	cmd.Stderr = tty
	// A new session with the tty as controlling terminal makes the shell a
	// process-group leader, so Kill can take the whole group down.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	if err := cmd.Start(); err != nil {
		_ = tty.Close()
		_ = ptmx.Close()
		return nil, err
	}
	_ = tty.Close()
	_ = pty.Setsize(ptmx, &pty.Winsize{Cols: spec.cols, Rows: spec.rows})
	return &process{cmd: cmd, ptmx: ptmx}, nil
}

func (p *process) Read(b []byte) (int, error)  { return p.ptmx.Read(b) }
func (p *process) Write(b []byte) (int, error) { return p.ptmx.Write(b) }

func (p *process) Resize(cols, rows uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func (p *process) IsPTY() bool { return true }

// Wait blocks until the shell exits. A signal death returns a nil exit code
// plus the signal name, matching the wire contract's code:null + signal.
func (p *process) Wait() (*int, string, error) {
	err := p.cmd.Wait()
	if err == nil {
		code := 0
		return &code, "", nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return nil, status.Signal().String(), nil
		}
		code := exitErr.ExitCode()
		return &code, "", nil
	}
	return nil, "", err
}

// Kill terminates the shell's process group (setsid made the shell its
// leader), which also kills its children.
func (p *process) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	if err := syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL); err != nil {
		return p.cmd.Process.Kill()
	}
	return nil
}

func (p *process) Close() error {
	var err error
	p.closeOnce.Do(func() {
		if p.ptmx != nil {
			err = p.ptmx.Close()
		}
	})
	return err
}

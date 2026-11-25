//go:build linux

package tasks

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// killProcessTree kills every descendant of pid first, then pid itself. The
// shell recorded by the wrapper is the task's process, not the agent's, so
// process-group signalling is deliberately avoided.
func killProcessTree(pid int) error {
	if pid <= 0 {
		return nil
	}
	descendants := descendantsOf(pid)
	var firstErr error
	for i := len(descendants) - 1; i >= 0; i-- {
		if err := syscall.Kill(descendants[i], syscall.SIGKILL); err != nil &&
			!errors.Is(err, syscall.ESRCH) && firstErr == nil {
			firstErr = err
		}
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil &&
		!errors.Is(err, syscall.ESRCH) && firstErr == nil {
		firstErr = err
	}
	return firstErr
}

func descendantsOf(root int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	children := make(map[int][]int)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		status, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "status"))
		if err != nil {
			continue
		}
		ppid := parentPID(status)
		if ppid > 0 {
			children[ppid] = append(children[ppid], pid)
		}
	}
	var out []int
	queue := append([]int{}, children[root]...)
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		out = append(out, current)
		queue = append(queue, children[current]...)
	}
	return out
}

func parentPID(status []byte) int {
	for _, line := range strings.Split(string(status), "\n") {
		if !strings.HasPrefix(line, "PPid:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		value, err := strconv.Atoi(fields[1])
		if err != nil {
			return 0
		}
		return value
	}
	return 0
}

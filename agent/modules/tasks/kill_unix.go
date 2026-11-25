//go:build darwin || freebsd

package tasks

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// killProcessTree kills the descendants reported by ps, then the shell itself.
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
	out, err := exec.Command("/bin/ps", "-axo", "pid=,ppid=").Output()
	if err != nil {
		return nil
	}
	children := make(map[int][]int)
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		children[ppid] = append(children[ppid], pid)
	}
	var result []int
	queue := append([]int{}, children[root]...)
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		result = append(result, current)
		queue = append(queue, children[current]...)
	}
	return result
}

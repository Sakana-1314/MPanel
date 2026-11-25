//go:build windows

package tasks

import (
	"os/exec"
	"strconv"
)

// killProcessTree relies on taskkill /T, which walks the whole process tree
// rooted at the PowerShell wrapper that launched the task shell.
func killProcessTree(pid int) error {
	if pid <= 0 {
		return nil
	}
	cmd := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
	return cmd.Run()
}

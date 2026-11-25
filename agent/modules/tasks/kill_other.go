//go:build !linux && !darwin && !freebsd && !windows

package tasks

import "os"

func killProcessTree(pid int) error {
	if pid <= 0 {
		return nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return process.Kill()
}

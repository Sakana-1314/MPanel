//go:build !linux && !darwin && !freebsd && !windows

package tasks

// buildInvocation is the generic fallback: invoke the configured shell with
// the command as its final argument. No pid file / tree-kill support exists on
// these platforms.
func buildInvocation(shell shellSpec, task *Task, _ string) (string, []string, error) {
	args := append([]string{}, shell.args...)
	args = append(args, task.Command)
	return shell.name, args, nil
}

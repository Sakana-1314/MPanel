//go:build linux || darwin || freebsd

package tasks

import (
	"strings"
)

// buildInvocation wraps the task command in a short POSIX script that records
// the shell pid (for timeout tree-kill), drops panel credentials, applies cwd
// and env, then runs the trusted-owner command string.
func buildInvocation(shell shellSpec, task *Task, pidFile string) (string, []string, error) {
	var b strings.Builder
	b.WriteString("__mpanel_pid=" + shellQuote(pidFile) + "\n")
	b.WriteString("printf '%s' \"$$\" > \"$__mpanel_pid\"\n")
	b.WriteString("unset MPANEL_TOKEN MPANEL_SECRET_KEY MPANEL_CORE_TOKEN MPANEL_MACHINE_SECRET 2>/dev/null\n")
	if task.Cwd != nil && strings.TrimSpace(*task.Cwd) != "" {
		b.WriteString("cd " + shellQuote(strings.TrimSpace(*task.Cwd)) + " || exit 1\n")
	}
	for _, key := range sortedKeys(task.Env) {
		b.WriteString("export " + shellQuote(key+"="+task.Env[key]) + "\n")
	}
	b.WriteString(task.Command)
	if !strings.HasSuffix(task.Command, "\n") {
		b.WriteString("\n")
	}
	args := append([]string{}, shell.args...)
	args = append(args, b.String())
	return shell.name, args, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

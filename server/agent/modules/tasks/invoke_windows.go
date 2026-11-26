//go:build windows

package tasks

import (
	"encoding/base64"
	"os"
	"os/exec"
	"strings"
	"unicode/utf16"
)

// buildInvocation launches the trusted-owner command through Windows
// PowerShell so the run has a stable pid (for timeout tree-kill), explicit
// cwd/env, and panel credentials removed before the configured shell starts.
func buildInvocation(shell shellSpec, task *Task, pidFile string) (string, []string, error) {
	powershell, err := powershellPath()
	if err != nil {
		// Without PowerShell there is no pid file; execution still works, but
		// a timeout can only kill the direct shell process.
		args := append([]string{}, shell.args...)
		args = append(args, task.Command)
		return shell.name, args, nil
	}
	script := buildPowerShellScript(shell, task, pidFile)
	encoded := base64.StdEncoding.EncodeToString(utf16LE(script))
	return powershell, []string{"-NoProfile", "-NonInteractive", "-EncodedCommand", encoded}, nil
}

func powershellPath() (string, error) {
	for _, name := range []string{"powershell.exe", "pwsh.exe"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", os.ErrNotExist
}

func buildPowerShellScript(shell shellSpec, task *Task, pidFile string) string {
	var b strings.Builder
	b.WriteString("$ErrorActionPreference = 'Continue'\n")
	b.WriteString("try { Set-Content -LiteralPath " + psQuote(pidFile) + " -Value $PID -Encoding ASCII -ErrorAction Stop } catch { }\n")
	for _, key := range deniedEnv {
		b.WriteString("[Environment]::SetEnvironmentVariable(" + psQuote(key) + ", $null, 'Process')\n")
	}
	if task.Cwd != nil && strings.TrimSpace(*task.Cwd) != "" {
		b.WriteString("try { Set-Location -LiteralPath " + psQuote(strings.TrimSpace(*task.Cwd)) + " -ErrorAction Stop } catch { Write-Error $_; exit 1 }\n")
	}
	for _, key := range sortedKeys(task.Env) {
		b.WriteString("[Environment]::SetEnvironmentVariable(" + psQuote(key) + ", " + psQuote(task.Env[key]) + ", 'Process')\n")
	}
	b.WriteString("& " + psQuote(shell.name))
	for _, arg := range shell.args {
		b.WriteString(" " + psQuote(arg))
	}
	b.WriteString(" " + psQuote(task.Command) + "\n")
	b.WriteString("$ok = $?\n$code = $LASTEXITCODE\nif ($null -eq $code) { if ($ok) { $code = 0 } else { $code = 1 } }\nexit $code\n")
	return b.String()
}

func psQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func utf16LE(value string) []byte {
	units := utf16.Encode([]rune(value))
	out := make([]byte, len(units)*2)
	for i, unit := range units {
		out[i*2] = byte(unit)
		out[i*2+1] = byte(unit >> 8)
	}
	return out
}

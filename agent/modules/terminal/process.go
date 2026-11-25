package terminal

// processSpec describes one interactive shell process. The concrete process
// type and its helpers live in process_unix.go / process_windows.go so this
// shared file never imports creack/pty.
type processSpec struct {
	shell string
	cwd   string
	env   []string
	cols  uint16
	rows  uint16
}

//go:build !linux

package system

import (
	"net"
	"os"
	"runtime"
	"time"
)

// Non-Linux hosts (development, macOS) report what the standard library can
// answer without cgo: no /proc, so CPU percent, load average, host memory and
// disk usage are left null and the panel renders them as unavailable.

func cpuPercent() *float64 { return nil }

func hostMemory() (total, free uint64) { return 0, 0 }

func hostLoad() *[3]float64 { return nil }

func hostUptime() int64 { return 0 }

func diskUsage(string) (total, free *uint64) { return nil, nil }

func hostRelease() string { return runtime.GOOS }

func hostIPs() []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
			out = append(out, ipNet.IP.String())
		}
	}
	return out
}

var processStarted = time.Now()

// processUptime is used when the host uptime is unknown.
func processUptime() int64 { return int64(time.Since(processStarted).Seconds()) }

var _ = os.Getpid

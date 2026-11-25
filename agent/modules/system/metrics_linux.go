//go:build linux

package system

import (
	"bufio"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// cpuPercent samples /proc/stat twice, 200ms apart.
func cpuPercent() *float64 {
	total1, idle1, ok1 := readCPU()
	if !ok1 {
		return nil
	}
	time.Sleep(200 * time.Millisecond)
	total2, idle2, ok2 := readCPU()
	if !ok2 {
		return nil
	}
	totalDelta := float64(total2 - total1)
	idleDelta := float64(idle2 - idle1)
	if totalDelta <= 0 {
		return nil
	}
	value := (totalDelta - idleDelta) / totalDelta * 100
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	return &value
}

func readCPU() (total, idle uint64, ok bool) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	line := strings.SplitN(string(data), "\n", 2)[0]
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, false
	}
	for i, raw := range fields[1:] {
		value, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			continue
		}
		total += value
		if i == 3 || i == 4 { // idle + iowait
			idle += value
		}
	}
	return total, idle, true
}

func hostMemory() (total, free uint64) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		bytes := value * 1024
		switch fields[0] {
		case "MemTotal:":
			total = bytes
		case "MemAvailable:":
			free = bytes
		}
	}
	return total, free
}

func hostLoad() *[3]float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(data))
	if len(fields) < 3 {
		return nil
	}
	var out [3]float64
	for i := 0; i < 3; i++ {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return nil
		}
		out[i] = value
	}
	return &out
}

func hostUptime() int64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return int64(value)
}

func diskUsage(path string) (total, free *uint64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return nil, nil
	}
	blockSize := uint64(stat.Bsize)
	t := stat.Blocks * blockSize
	f := stat.Bavail * blockSize
	return &t, &f
}

// hostRelease returns the kernel release, which is what operators compare.
func hostRelease() string {
	var utsname syscall.Utsname
	if err := syscall.Uname(&utsname); err != nil {
		return ""
	}
	buf := make([]byte, 0, len(utsname.Release))
	for _, c := range utsname.Release {
		if c == 0 {
			break
		}
		buf = append(buf, byte(c))
	}
	return string(buf)
}

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

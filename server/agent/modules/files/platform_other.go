//go:build !linux && !windows

package files

import (
	"os"
	"time"
)

// createdTime falls back to mtime on platforms without a portable ctime.
func createdTime(info os.FileInfo) time.Time { return info.ModTime() }

// diskUsage is unavailable on this platform; the fields stay null.
func diskUsage(string) (*int64, *int64) { return nil, nil }

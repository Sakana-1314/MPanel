//go:build linux

package files

import (
	"os"
	"syscall"
	"time"
)

// createdTime returns the inode change time on Linux; the FileItem contract's
// ctime maps to it better than the modification time.
func createdTime(info os.FileInfo) time.Time {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return time.Unix(st.Ctim.Sec, st.Ctim.Nsec)
	}
	return info.ModTime()
}

// diskUsage reports free and total bytes of the filesystem holding path.
func diskUsage(path string) (*int64, *int64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil, nil
	}
	free := int64(st.Bavail) * int64(st.Bsize)
	total := int64(st.Blocks) * int64(st.Bsize)
	if free < 0 {
		free = 0
	}
	if total < 0 {
		total = 0
	}
	return &free, &total
}

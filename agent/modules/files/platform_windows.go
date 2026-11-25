//go:build windows

package files

import (
	"os"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32Proc         = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceProc = kernel32Proc.NewProc("GetDiskFreeSpaceExW")
)

// createdTime returns the NTFS creation time when the platform exposes it.
func createdTime(info os.FileInfo) time.Time {
	if data, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return time.Unix(0, data.CreationTime.Nanoseconds())
	}
	return info.ModTime()
}

// diskUsage reports free and total bytes of the volume holding path.
func diskUsage(path string) (*int64, *int64) {
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, nil
	}
	var freeAvailable, total, freeTotal uint64
	ok, _, _ := getDiskFreeSpaceProc.Call(
		uintptr(unsafe.Pointer(ptr)),
		uintptr(unsafe.Pointer(&freeAvailable)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&freeTotal)),
	)
	if ok == 0 {
		return nil, nil
	}
	free := int64(freeAvailable)
	totalBytes := int64(total)
	if free < 0 {
		free = 0
	}
	if totalBytes < 0 {
		totalBytes = 0
	}
	return &free, &totalBytes
}

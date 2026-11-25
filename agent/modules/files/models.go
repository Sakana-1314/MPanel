package files

import (
	"os"
	"path/filepath"
	"time"
)

// FileRoot mirrors web/panel/src/api/types.ts FileRoot (contract §10.1).
type FileRoot struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Writable   bool   `json:"writable"`
	FreeBytes  *int64 `json:"freeBytes"`
	TotalBytes *int64 `json:"totalBytes"`
}

// FileItem mirrors FileItem. Path is always a virtual POSIX path inside the
// root; the real host path is never exposed here.
type FileItem struct {
	Name       string  `json:"name"`
	Root       string  `json:"root"`
	Path       string  `json:"path"`
	Type       string  `json:"type"`
	Size       int64   `json:"size"`
	MTime      string  `json:"mtime"`
	CTime      string  `json:"ctime"`
	Mode       string  `json:"mode"`
	Readonly   bool    `json:"readonly"`
	IsSymlink  bool    `json:"isSymlink"`
	TargetType *string `json:"targetType"`
}

// FileListResult is FileListResult in the contract.
type FileListResult struct {
	Available  bool       `json:"available"`
	Reason     string     `json:"reason,omitempty"`
	Items      []FileItem `json:"items"`
	NextCursor string     `json:"nextCursor,omitempty"`
	Total      *int       `json:"total,omitempty"`
	Root       string     `json:"root"`
	Path       string     `json:"path"`
}

// FileReadResult mirrors FileReadResult.
type FileReadResult struct {
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	MTime     string `json:"mtime"`
	IsBinary  bool   `json:"isBinary"`
}

// FileSearchResult mirrors FileSearchResult.
type FileSearchResult struct {
	Available  bool       `json:"available"`
	Reason     string     `json:"reason,omitempty"`
	Items      []FileItem `json:"items"`
	NextCursor string     `json:"nextCursor,omitempty"`
	Total      *int       `json:"total,omitempty"`
	Query      string     `json:"query"`
	Truncated  bool       `json:"truncated"`
}

// TrashEntry mirrors TrashEntry.
type TrashEntry struct {
	ID           string `json:"id"`
	Root         string `json:"root"`
	OriginalPath string `json:"originalPath"`
	TrashedAt    string `json:"trashedAt"`
	SizeBytes    int64  `json:"sizeBytes"`
	Type         string `json:"type"`
}

// FileArchiveResult mirrors FileArchiveResult.
type FileArchiveResult struct {
	Path      string `json:"path"`
	Format    string `json:"format"`
	SizeBytes int64  `json:"sizeBytes"`
	Entries   int    `json:"entries"`
}

// FileExtractResult mirrors FileExtractResult.
type FileExtractResult struct {
	Destination string `json:"destination"`
	Entries     int    `json:"entries"`
}

const (
	fileTypeFile      = "file"
	fileTypeDirectory = "directory"
	fileTypeSymlink   = "symlink"
	fileTypeOther     = "other"
)

// formatTime renders millisecond RFC 3339 UTC timestamps, matching the
// contract's "2026-11-25T08:30:00.000Z" example.
func formatTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func fileTypeOf(info os.FileInfo) string {
	mode := info.Mode()
	switch {
	case mode&os.ModeSymlink != 0:
		return fileTypeSymlink
	case mode.IsDir():
		return fileTypeDirectory
	case mode.IsRegular():
		return fileTypeFile
	default:
		return fileTypeOther
	}
}

func virtualName(virtual string) string {
	if virtual == "/" {
		return "/"
	}
	if idx := lastSlashIndex(virtual); idx >= 0 {
		return virtual[idx+1:]
	}
	return virtual
}

func lastSlashIndex(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' {
			return i
		}
	}
	return -1
}

func joinVirtual(dir, name string) string {
	if dir == "/" || dir == "" {
		return "/" + name
	}
	return dir + "/" + name
}

// itemFromInfo builds a FileItem from Lstat information. host is used only to
// classify a symlink target; it is never serialized.
func itemFromInfo(rootReal, rootName, virtual, host string, info os.FileInfo) FileItem {
	item := FileItem{
		Name:      virtualName(virtual),
		Root:      rootName,
		Path:      virtual,
		Type:      fileTypeOf(info),
		Size:      info.Size(),
		MTime:     formatTime(info.ModTime()),
		CTime:     formatTime(createdTime(info)),
		Mode:      formatMode(info),
		Readonly:  info.Mode().Perm()&0o222 == 0,
		IsSymlink: info.Mode()&os.ModeSymlink != 0,
	}
	if item.IsSymlink && rootReal != "" {
		// Never follow a symlink that escapes the sandbox: it would leak the
		// target's type/size/mtime even though content access is rejected.
		if target, err := filepath.EvalSymlinks(host); err == nil && within(rootReal, target) {
			if targetInfo, statErr := os.Stat(target); statErr == nil {
				targetType := fileTypeOf(targetInfo)
				item.TargetType = &targetType
				item.Size = targetInfo.Size()
				item.MTime = formatTime(targetInfo.ModTime())
			}
		}
	}
	return item
}

func itemFromResolved(res *resolved) FileItem {
	return itemFromInfo(res.rootReal, res.root.name, res.virtual, res.host, res.info)
}

func formatMode(info os.FileInfo) string {
	mode := info.Mode()
	value := uint32(mode.Perm())
	if mode&os.ModeSetuid != 0 {
		value |= 0o4000
	}
	if mode&os.ModeSetgid != 0 {
		value |= 0o2000
	}
	if mode&os.ModeSticky != 0 {
		value |= 0o1000
	}
	return octalPerm(value)
}

func octalPerm(p uint32) string {
	const digits = "01234567"
	out := make([]byte, 4)
	for i := 3; i >= 0; i-- {
		out[i] = digits[p&0o7]
		p >>= 3
	}
	return string(out)
}

// Package files implements the sandboxed file manager exposed under
// /api/v1/files. Every request path is a POSIX virtual path relative to one of
// the configured roots (MPANEL_FILES_ROOTS); the host path is derived by
// cleaning, realpath-ing and prefix-checking, so "..", absolute host paths,
// Windows drive letters / reserved names and symlink escapes are rejected.
package files

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

const (
	maxVirtualPathLen = 4096
	maxSegmentLen     = 255
)

var rootNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$`)

// rootRef is one configured sandbox root. The path is always absolute and
// cleaned; it is never returned to clients except through GET /files/roots
// (the contract requires the host path there).
type rootRef struct {
	name string
	path string
}

// sandbox owns the configured roots and resolves virtual paths into host paths.
type sandbox struct {
	roots  []rootRef
	byName map[string]rootRef
}

func newSandbox(roots []config.Root) *sandbox {
	sb := &sandbox{byName: make(map[string]rootRef, len(roots))}
	for _, root := range roots {
		name := strings.TrimSpace(root.Name)
		if !rootNamePattern.MatchString(name) {
			continue
		}
		if _, exists := sb.byName[name]; exists {
			continue
		}
		path := strings.TrimSpace(root.Path)
		if path == "" || strings.IndexByte(path, 0) >= 0 {
			continue
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			continue
		}
		ref := rootRef{name: name, path: filepath.Clean(abs)}
		sb.roots = append(sb.roots, ref)
		sb.byName[name] = ref
	}
	return sb
}

func (sb *sandbox) root(name string) (rootRef, error) {
	ref, ok := sb.byName[name]
	if !ok {
		return rootRef{}, protocol.NotFound("文件根", name)
	}
	return ref, nil
}

// realRoot validates that the root still exists, is a directory and resolves
// its symlinks. The result is the prefix every resolved target must stay in.
func (sb *sandbox) realRoot(ref rootRef) (string, error) {
	info, err := os.Stat(ref.path)
	if err != nil {
		return "", rootUnavailable(ref.name)
	}
	if !info.IsDir() {
		return "", rootUnavailable(ref.name)
	}
	real, err := filepath.EvalSymlinks(ref.path)
	if err != nil {
		return "", rootUnavailable(ref.name)
	}
	real = filepath.Clean(real)
	if !filepath.IsAbs(real) {
		return "", rootUnavailable(ref.name)
	}
	return real, nil
}

// availability reports whether at least one root resolves, mirroring the
// contract rule for /files lists (available=false instead of a hard error).
func (sb *sandbox) availability() (bool, string) {
	if len(sb.roots) == 0 {
		return false, "未配置文件根：请设置 MPANEL_FILES_ROOTS（name=/abs/path）"
	}
	for _, ref := range sb.roots {
		if _, err := sb.realRoot(ref); err == nil {
			return true, ""
		}
	}
	return false, "没有可用的文件根：请确认 MPANEL_FILES_ROOTS 指向存在且可读的绝对目录"
}

// resolved is one path resolution outcome.
type resolved struct {
	root     rootRef
	rootReal string
	virtual  string // canonical virtual path, always starts with "/"
	rel      string // OS-relative path inside the root ("" for the root itself)
	host     string // lexical host path (a symlink is not followed here)
	target   string // realpath inside the root; equal to host when nothing is linked
	exists   bool
	info     os.FileInfo // Lstat information when the entry exists
	// brokenLink marks an existing symlink whose target cannot be resolved.
	// Such links may be deleted, but must not be read or written through.
	brokenLink bool
}

// resolve maps root+virtual to a host path and verifies that:
//   - the virtual path contains no "..", NUL, control chars, backslash, drive
//     letter, UNC prefix or Windows reserved name;
//   - the lexical host path stays under the realpath of the root;
//   - an existing symlink (or the deepest existing ancestor of a new path)
//     resolves to a path that is still inside the root.
func (sb *sandbox) resolve(rootName, virtual string) (*resolved, error) {
	ref, err := sb.root(rootName)
	if err != nil {
		return nil, err
	}
	real, err := sb.realRoot(ref)
	if err != nil {
		return nil, err
	}
	v, err := normalizeVirtual(virtual)
	if err != nil {
		return nil, err
	}
	res := &resolved{root: ref, rootReal: real, virtual: v}
	if v == "/" {
		res.host = real
		res.target = real
		if info, statErr := os.Lstat(real); statErr == nil {
			res.exists = true
			res.info = info
		}
		return res, nil
	}
	res.rel = strings.TrimPrefix(v, "/")
	host := filepath.Clean(filepath.Join(real, filepath.FromSlash(res.rel)))
	if !within(real, host) {
		return nil, pathErr("路径越界：目标不在文件根内")
	}
	res.host = host
	info, statErr := os.Lstat(host)
	switch {
	case statErr == nil:
		res.exists = true
		res.info = info
		target, linkErr := filepath.EvalSymlinks(host)
		if linkErr != nil {
			if info.Mode()&os.ModeSymlink != 0 {
				res.brokenLink = true
				return res, nil
			}
			return nil, mapFSError(linkErr, v)
		}
		target = filepath.Clean(target)
		if !within(real, target) {
			return nil, pathErr("符号链接指向文件根之外")
		}
		res.target = target
	case os.IsNotExist(statErr):
		target, missErr := resolveMissing(real, host)
		if missErr != nil {
			return nil, missErr
		}
		res.target = target
	default:
		return nil, mapFSError(statErr, v)
	}
	return res, nil
}

// resolveMissing resolves the deepest existing ancestor of host and re-attaches
// the not-yet-existing tail. It is used for write destinations, restores and
// archive/extract targets so that a symlinked parent cannot escape the root.
func resolveMissing(realRoot, host string) (string, error) {
	current := host
	var tail []string
	for {
		info, err := os.Lstat(current)
		if err == nil {
			if !info.IsDir() && len(tail) > 0 {
				return "", pathErr("路径的上级不是目录")
			}
			real, linkErr := filepath.EvalSymlinks(current)
			if linkErr != nil {
				return "", pathErr("符号链接目标不存在或越界")
			}
			real = filepath.Clean(real)
			if !within(realRoot, real) {
				return "", pathErr("符号链接指向文件根之外")
			}
			for i := len(tail) - 1; i >= 0; i-- {
				real = filepath.Join(real, tail[i])
			}
			if !within(realRoot, real) {
				return "", pathErr("路径越界：目标不在文件根内")
			}
			return real, nil
		}
		if !os.IsNotExist(err) {
			if os.IsPermission(err) {
				return "", forbiddenErr()
			}
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", pathErr("路径的上级目录不存在")
		}
		tail = append(tail, filepath.Base(current))
		current = parent
	}
}

// normalizeVirtual converts a client supplied path into the canonical virtual
// form: one leading slash, no trailing slash (except "/"), no "." segments.
func normalizeVirtual(raw string) (string, error) {
	if len(raw) > maxVirtualPathLen {
		return "", pathErr("路径过长")
	}
	for i := 0; i < len(raw); i++ {
		b := raw[i]
		if b == 0 || b < 0x20 || b == 0x7f {
			return "", pathErr("路径不能包含控制字符")
		}
	}
	if strings.ContainsRune(raw, '\\') {
		return "", pathErr("路径不能包含反斜杠（请使用 POSIX 分隔符 /）")
	}
	if strings.HasPrefix(raw, "//") {
		return "", pathErr("路径不能是 UNC 路径")
	}
	parts := strings.Split(raw, "/")
	out := make([]string, 0, len(parts))
	for _, segment := range parts {
		if segment == "" || segment == "." {
			continue
		}
		if segment == ".." {
			return "", pathErr("路径不能包含 “..” 段")
		}
		if err := validateSegment(segment); err != nil {
			return "", err
		}
		out = append(out, segment)
	}
	if len(out) == 0 {
		return "/", nil
	}
	return "/" + strings.Join(out, "/"), nil
}

func validateSegment(segment string) error {
	if len(segment) > maxSegmentLen {
		return pathErr("文件名过长")
	}
	if strings.ContainsAny(segment, "\x00") {
		return pathErr("路径不能包含控制字符")
	}
	if runtime.GOOS == "windows" {
		if strings.ContainsAny(segment, ":*?\"<>|") {
			return pathErr("路径包含 Windows 不允许的字符")
		}
		if strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
			return pathErr("路径不能以点或空格结尾")
		}
	} else if len(segment) >= 2 && isASCIILetter(segment[0]) && segment[1] == ':' {
		return pathErr("路径不能包含 Windows 盘符")
	}
	if isWindowsReservedName(segment) {
		return pathErr("路径包含 Windows 保留名（如 CON、PRN、AUX、NUL、COM1、LPT1）")
	}
	return nil
}

func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// isWindowsReservedName rejects device names on every platform so a sandbox
// that is moved between hosts keeps the same guarantees.
func isWindowsReservedName(segment string) bool {
	base := segment
	if idx := strings.IndexByte(base, '.'); idx >= 0 {
		base = base[:idx]
	}
	base = strings.TrimRight(base, " .")
	base = strings.ToUpper(base)
	switch base {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(base) == 4 {
		prefix := base[:3]
		if (prefix == "COM" || prefix == "LPT") && base[3] >= '1' && base[3] <= '9' {
			return true
		}
	}
	return false
}

// within reports whether target is base or below it. filepath.Rel compares
// volumes and case the platform's way, so Windows drive changes and different
// volumes are rejected.
func within(base, target string) bool {
	rel, err := filepath.Rel(filepath.Clean(base), filepath.Clean(target))
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// samePath compares two host paths using the platform's case rules.
func samePath(a, b string) bool {
	cleanA, cleanB := filepath.Clean(a), filepath.Clean(b)
	if cleanA == cleanB {
		return true
	}
	if runtime.GOOS == "windows" && strings.EqualFold(cleanA, cleanB) {
		return true
	}
	return within(a, b) && within(b, a)
}

func pathErr(message string) *protocol.PanelError {
	return &protocol.PanelError{
		Code:    protocol.CodeBadRequest,
		Message: message,
		Hint:    "路径必须是文件根内的 POSIX 虚拟路径，不能包含 “..”、反斜杠、盘符、Windows 保留名或控制字符，也不能通过符号链接逃逸。",
	}
}

func rootUnavailable(name string) *protocol.PanelError {
	return &protocol.PanelError{
		Code:    protocol.CodeUnavailable,
		Message: "文件根不可用",
		Hint:    "请确认 agent 配置中的文件根（MPANEL_FILES_ROOTS）指向存在、可读且为目录的绝对路径，然后重试。",
		Details: map[string]any{"root": name},
	}
}

func forbiddenErr() *protocol.PanelError {
	return &protocol.PanelError{
		Code:    protocol.CodeForbidden,
		Message: "无权限访问该路径",
		Hint:    "请确认 agent 进程对文件根目录及其内容有足够的读写权限。",
	}
}

// mapFSError maps filesystem errors to the closed API error set without
// leaking absolute host paths.
func mapFSError(err error, virtual string) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, os.ErrNotExist):
		return protocol.NotFound("文件", virtual)
	case errors.Is(err, os.ErrPermission):
		return forbiddenErr()
	}
	return err
}

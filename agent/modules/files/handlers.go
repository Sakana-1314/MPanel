package files

import (
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/core/httpapi"
	"github.com/sakana-1314/mpanel/core/protocol"
)

// handleRoots implements GET /api/v1/files/roots.
func (m *Module) handleRoots(w http.ResponseWriter, r *http.Request) {
	roots := make([]FileRoot, 0, len(m.sb.roots))
	for _, ref := range m.sb.roots {
		real, err := m.sb.realRoot(ref)
		if err != nil {
			continue
		}
		root := FileRoot{Name: ref.name, Path: ref.path, Writable: probeWritable(real)}
		root.FreeBytes, root.TotalBytes = diskUsage(real)
		roots = append(roots, root)
	}
	if len(roots) == 0 {
		_, reason := m.sb.availability()
		httpapi.OK(w, protocol.UnavailableList[FileRoot](reason))
		return
	}
	httpapi.OK(w, protocol.NewList(roots))
}

func probeWritable(dir string) bool {
	file, err := os.CreateTemp(dir, ".mpanel-probe-*")
	if err != nil {
		return false
	}
	name := file.Name()
	_ = file.Close()
	_ = os.Remove(name)
	return true
}

// handleList implements GET /api/v1/files/list (and the /files alias).
func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	rootName, virtual, ok := m.requireRootPath(w, r)
	if !ok {
		return
	}
	limit, err := pageLimit(r, defaultListLimit, maxListLimit)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	offset, err := pageCursor(r)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	showHidden, _, err := boolQuery(r, "showHidden", "hidden")
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	sortMode := r.URL.Query().Get("sort")

	res, err := m.sb.resolve(rootName, virtual)
	if err != nil {
		var panelErr *protocol.PanelError
		if errors.As(err, &panelErr) && panelErr.Code == protocol.CodeUnavailable {
			_, reason := m.sb.availability()
			httpapi.OK(w, FileListResult{Available: false, Reason: reason, Items: []FileItem{}, Root: rootName, Path: "/"})
			return
		}
		httpapi.Fail(w, err)
		return
	}
	if !res.exists || res.brokenLink {
		httpapi.Fail(w, protocol.NotFound("目录", res.virtual))
		return
	}
	if !isDirTarget(res) {
		httpapi.Fail(w, protocol.BadRequest("目标不是目录"))
		return
	}
	entries, err := os.ReadDir(res.target)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	items := make([]FileItem, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		host := filepath.Join(res.target, name)
		items = append(items, itemFromInfo(res.rootReal, rootName, joinVirtual(res.virtual, name), host, info))
	}
	if err := sortItems(items, sortMode); err != nil {
		httpapi.Fail(w, err)
		return
	}
	total := len(items)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	next := ""
	if end < total {
		next = strconv.Itoa(end)
	}
	result := FileListResult{
		Available:  true,
		Items:      items[offset:end],
		NextCursor: next,
		Total:      &total,
		Root:       rootName,
		Path:       res.virtual,
	}
	if result.Items == nil {
		result.Items = []FileItem{}
	}
	httpapi.OK(w, result)
}

func isDirTarget(res *resolved) bool {
	if res.info != nil && res.info.IsDir() {
		return true
	}
	if res.info != nil && res.info.Mode()&os.ModeSymlink != 0 {
		if info, err := os.Stat(res.host); err == nil {
			return info.IsDir()
		}
	}
	return false
}

func parseSortMode(mode string) (key string, desc bool, err error) {
	switch mode {
	case "", "name", "name_asc":
		return "name", false, nil
	case "name_desc":
		return "name", true, nil
	case "size", "size_asc":
		return "size", false, nil
	case "size_desc":
		return "size", true, nil
	case "mtime", "mtime_asc", "modtime", "modtime_asc":
		return "mtime", false, nil
	case "mtime_desc", "modtime_desc":
		return "mtime", true, nil
	case "type", "type_asc":
		return "type", false, nil
	case "type_desc":
		return "type", true, nil
	default:
		return "", false, protocol.BadRequest("sort 只支持 name/size/mtime/type（可加 _desc）")
	}
}

func sortItems(items []FileItem, mode string) error {
	key, desc, err := parseSortMode(mode)
	if err != nil {
		return err
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		aDir := a.Type == fileTypeDirectory
		bDir := b.Type == fileTypeDirectory
		if aDir != bDir {
			// Directories always sort first (contract §10.2), regardless of desc.
			return aDir
		}
		compare := 0
		switch key {
		case "size":
			switch {
			case a.Size < b.Size:
				compare = -1
			case a.Size > b.Size:
				compare = 1
			}
		case "mtime":
			compare = strings.Compare(a.MTime, b.MTime)
		case "type":
			compare = strings.Compare(a.Type, b.Type)
		}
		if compare == 0 {
			compare = strings.Compare(a.Name, b.Name)
			if compare == 0 {
				compare = strings.Compare(a.Path, b.Path)
			}
		}
		if desc {
			return compare > 0
		}
		return compare < 0
	})
	return nil
}

// handleStat implements GET /api/v1/files/stat.
func (m *Module) handleStat(w http.ResponseWriter, r *http.Request) {
	rootName, virtual, ok := m.requireRootPath(w, r)
	if !ok {
		return
	}
	res, err := m.sb.resolve(rootName, virtual)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !res.exists {
		httpapi.Fail(w, protocol.NotFound("文件", res.virtual))
		return
	}
	if res.brokenLink {
		httpapi.Fail(w, pathErr("符号链接目标不存在或越界"))
		return
	}
	httpapi.OK(w, itemFromResolved(res))
}

// handleRead implements GET /api/v1/files/read.
func (m *Module) handleRead(w http.ResponseWriter, r *http.Request) {
	rootName, virtual, ok := m.requireRootPath(w, r)
	if !ok {
		return
	}
	encoding := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("encoding")))
	if encoding == "" {
		encoding = "utf8"
	}
	if encoding != "utf8" && encoding != "base64" {
		httpapi.Fail(w, protocol.BadRequest("encoding 只支持 utf8 或 base64"))
		return
	}
	maxBytes := defaultReadBytes
	if value, present, err := intQuery(r, "maxBytes"); err != nil {
		httpapi.Fail(w, err)
		return
	} else if present {
		if value < 1 {
			httpapi.Fail(w, protocol.BadRequest("maxBytes 必须不小于 1"))
			return
		}
		if value > maxReadBytes {
			httpapi.Fail(w, protocol.BadRequest("maxBytes 最大 8 MiB"))
			return
		}
		maxBytes = value
	}
	res, err := m.sb.resolve(rootName, virtual)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !res.exists || res.brokenLink {
		httpapi.Fail(w, protocol.NotFound("文件", res.virtual))
		return
	}
	info, err := os.Stat(res.host)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	if info.IsDir() {
		httpapi.Fail(w, protocol.BadRequest("不能读取目录"))
		return
	}
	if !info.Mode().IsRegular() {
		httpapi.Fail(w, protocol.BadRequest("只能读取普通文件"))
		return
	}
	file, err := os.Open(res.host)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	defer file.Close()
	buf := make([]byte, maxBytes+1)
	n, readErr := io.ReadFull(file, buf)
	if readErr != nil && readErr != io.ErrUnexpectedEOF && readErr != io.EOF {
		httpapi.Fail(w, readErr)
		return
	}
	truncated := n > maxBytes
	if truncated {
		n = maxBytes
	}
	binary := isBinaryData(buf[:n])
	if binary && encoding != "base64" {
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "文件是二进制内容，不能按 UTF-8 读取",
			Hint:    "请使用 encoding=base64 读取，或通过 /files/download 下载原始字节。",
			Details: map[string]any{"isBinary": true},
		})
		return
	}
	content := string(buf[:n])
	if encoding == "base64" {
		content = base64.StdEncoding.EncodeToString(buf[:n])
	}
	httpapi.OK(w, FileReadResult{
		Content:   content,
		Encoding:  encoding,
		Size:      info.Size(),
		Truncated: truncated,
		MTime:     formatTime(info.ModTime()),
		IsBinary:  binary,
	})
}

// handleWrite implements PUT/POST /api/v1/files/write.
func (m *Module) handleWrite(w http.ResponseWriter, r *http.Request) {
	var req writeRequest
	if !decodeBody(w, r, &req, maxWriteBodyBytes) {
		return
	}
	if strings.TrimSpace(req.Root) == "" {
		httpapi.Fail(w, protocol.BadRequest("root 不能为空"))
		return
	}
	if req.Path == "" {
		httpapi.Fail(w, protocol.BadRequest("path 不能为空"))
		return
	}
	var data []byte
	switch strings.ToLower(req.Encoding) {
	case "", "utf8":
		data = []byte(req.Content)
	case "base64":
		decoded, err := decodeBase64(req.Content)
		if err != nil {
			httpapi.Fail(w, protocol.BadRequest("content 不是合法的 base64"))
			return
		}
		data = decoded
	default:
		httpapi.Fail(w, protocol.BadRequest("encoding 只支持 utf8 或 base64"))
		return
	}
	create := true
	if req.Create != nil {
		create = *req.Create
	}
	overwrite := true
	if req.Overwrite != nil {
		overwrite = *req.Overwrite
	}
	res, err := m.sb.resolve(req.Root, req.Path)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if res.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("不能写入文件根目录"))
		return
	}
	mode := os.FileMode(0o644)
	if res.exists {
		if res.brokenLink || res.info.Mode()&os.ModeSymlink != 0 {
			httpapi.Fail(w, pathErr("不能通过符号链接写入文件"))
			return
		}
		if res.info.IsDir() {
			httpapi.Fail(w, protocol.BadRequest("目标是目录，不能写入"))
			return
		}
		if !overwrite {
			httpapi.Fail(w, protocol.Conflict("目标文件已存在"))
			return
		}
		mode = res.info.Mode().Perm()
		if req.ExpectedMtime != "" {
			expected, parseErr := parseTimeValue(req.ExpectedMtime)
			if parseErr != nil {
				httpapi.Fail(w, protocol.BadRequest("expectedMtime 不是合法的 RFC 3339 时间"))
				return
			}
			current := res.info.ModTime().UTC().Truncate(time.Millisecond)
			if !current.Equal(expected.UTC().Truncate(time.Millisecond)) {
				httpapi.Fail(w, &protocol.PanelError{
					Code:    protocol.CodeConflict,
					Message: "文件已被修改（mtime 不匹配）",
					Hint:    "请重新读取文件内容后再保存，或省略 expectedMtime 强制覆盖。",
				})
				return
			}
		}
	} else if !create {
		httpapi.Fail(w, protocol.NotFound("文件", res.virtual))
		return
	}
	parent := filepath.Dir(res.target)
	if err := ensureDir(parent); err != nil {
		httpapi.Fail(w, protocol.NotFound("上级目录", filepath.ToSlash(filepath.Dir(res.virtual))))
		return
	}
	if res.exists && req.CreateBackup != nil && *req.CreateBackup {
		if backupErr := copyFile(res.target, backupPath(res.target)); backupErr != nil {
			httpapi.Fail(w, mapFSError(backupErr, res.virtual))
			return
		}
	}
	if err := writeFileAtomic(res.target, data, mode); err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	info, err := os.Lstat(res.target)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	httpapi.OK(w, itemFromInfo(res.rootReal, req.Root, res.virtual, res.target, info))
}

func decodeBase64(value string) ([]byte, error) {
	if data, err := base64.StdEncoding.DecodeString(value); err == nil {
		return data, nil
	}
	return base64.RawStdEncoding.DecodeString(value)
}

func parseTimeValue(value string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, value)
}

func backupPath(target string) string {
	candidate := target + ".bak"
	if _, err := os.Lstat(candidate); err == nil {
		candidate = target + ".bak-" + time.Now().UTC().Format("20060102-150405")
	}
	return candidate
}

func writeFileAtomic(target string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".mpanel-write-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(mode.Perm()); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, target); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

// handleMkdir implements POST /api/v1/files/mkdir.
func (m *Module) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var req mkdirRequest
	if !decodeBody(w, r, &req, defaultJSONBytes) {
		return
	}
	if strings.TrimSpace(req.Root) == "" || req.Path == "" {
		httpapi.Fail(w, protocol.BadRequest("root 和 path 不能为空"))
		return
	}
	recursive := false
	if req.Recursive != nil {
		recursive = *req.Recursive
	}
	mode, err := parseOctalMode(req.Mode, 0o755)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	res, err := m.sb.resolve(req.Root, req.Path)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if res.exists {
		if !res.info.IsDir() {
			httpapi.Fail(w, protocol.Conflict("同名条目已存在且不是目录"))
			return
		}
		if res.brokenLink {
			httpapi.Fail(w, pathErr("符号链接目标不存在或越界"))
			return
		}
		if !recursive {
			httpapi.Fail(w, protocol.Conflict("目录已存在"))
			return
		}
		httpapi.OK(w, itemFromResolved(res))
		return
	}
	var mkErr error
	if recursive {
		mkErr = os.MkdirAll(res.target, mode)
	} else {
		if parentErr := ensureDir(filepath.Dir(res.target)); parentErr != nil {
			httpapi.Fail(w, protocol.NotFound("上级目录", filepath.ToSlash(filepath.Dir(res.virtual))))
			return
		}
		mkErr = os.Mkdir(res.target, mode)
	}
	if mkErr != nil {
		if os.IsExist(mkErr) {
			httpapi.Fail(w, protocol.Conflict("目录已存在"))
			return
		}
		httpapi.Fail(w, mapFSError(mkErr, res.virtual))
		return
	}
	info, err := os.Lstat(res.target)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	httpapi.OK(w, itemFromInfo(res.rootReal, req.Root, res.virtual, res.target, info))
}

func parseOctalMode(raw string, def os.FileMode) (os.FileMode, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def, nil
	}
	if len(raw) < 3 || len(raw) > 4 {
		return 0, protocol.BadRequest("mode 必须是 3 或 4 位八进制，例如 644、0755")
	}
	value, err := strconv.ParseUint(raw, 8, 32)
	if err != nil || value > 0o7777 {
		return 0, protocol.BadRequest("mode 必须是 3 或 4 位八进制，例如 644、0755")
	}
	mode := os.FileMode(value & 0o777)
	if value&0o4000 != 0 {
		mode |= os.ModeSetuid
	}
	if value&0o2000 != 0 {
		mode |= os.ModeSetgid
	}
	if value&0o1000 != 0 {
		mode |= os.ModeSticky
	}
	return mode, nil
}

// handleRename implements POST /api/v1/files/rename.
func (m *Module) handleRename(w http.ResponseWriter, r *http.Request) {
	var req renameRequest
	if !decodeBody(w, r, &req, defaultJSONBytes) {
		return
	}
	if strings.TrimSpace(req.Root) == "" || req.From == "" || req.To == "" {
		httpapi.Fail(w, protocol.BadRequest("root、from、to 不能为空"))
		return
	}
	from, err := m.sb.resolve(req.Root, req.From)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !from.exists {
		httpapi.Fail(w, protocol.NotFound("源路径", from.virtual))
		return
	}
	if from.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("不能重命名文件根目录"))
		return
	}
	if from.brokenLink || from.info.Mode()&os.ModeSymlink != 0 {
		httpapi.Fail(w, pathErr("不能重命名符号链接"))
		return
	}
	to, err := m.sb.resolve(req.Root, req.To)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if to.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("不能把条目重命名为文件根目录"))
		return
	}
	if from.virtual == to.virtual {
		httpapi.OK(w, itemFromResolved(from))
		return
	}
	if samePath(from.target, to.target) {
		// Case-only rename on case-insensitive filesystems must not delete the
		// source first; a direct rename handles it.
		if err := os.Rename(from.host, to.host); err != nil {
			httpapi.Fail(w, mapFSError(err, to.virtual))
			return
		}
		info, err := os.Lstat(to.host)
		if err != nil {
			httpapi.Fail(w, mapFSError(err, to.virtual))
			return
		}
		httpapi.OK(w, itemFromInfo(to.rootReal, req.Root, to.virtual, to.host, info))
		return
	}
	if from.info.IsDir() && within(from.target, to.target) {
		httpapi.Fail(w, protocol.BadRequest("不能把目录移动到自身内部"))
		return
	}
	if to.exists && (to.brokenLink || to.info.Mode()&os.ModeSymlink != 0) {
		httpapi.Fail(w, pathErr("不能覆盖符号链接"))
		return
	}
	overwrite := req.Overwrite != nil && *req.Overwrite
	if to.exists {
		if !overwrite {
			httpapi.Fail(w, protocol.Conflict("目标已存在"))
			return
		}
		if err := removeForOverwrite(to); err != nil {
			httpapi.Fail(w, err)
			return
		}
	}
	if err := ensureDir(filepath.Dir(to.target)); err != nil {
		httpapi.Fail(w, protocol.NotFound("上级目录", filepath.ToSlash(filepath.Dir(to.virtual))))
		return
	}
	if err := os.Rename(from.host, to.target); err != nil {
		httpapi.Fail(w, mapFSError(err, to.virtual))
		return
	}
	info, err := os.Lstat(to.target)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, to.virtual))
		return
	}
	httpapi.OK(w, itemFromInfo(to.rootReal, req.Root, to.virtual, to.target, info))
}

func removeForOverwrite(res *resolved) error {
	if res.info == nil {
		return nil
	}
	if res.info.IsDir() && res.info.Mode()&os.ModeSymlink == 0 {
		entries, err := os.ReadDir(res.host)
		if err != nil {
			return mapFSError(err, res.virtual)
		}
		if len(entries) > 0 {
			return protocol.Conflict("目标目录非空，不能覆盖")
		}
	}
	if err := os.Remove(res.host); err != nil {
		return mapFSError(err, res.virtual)
	}
	return nil
}

// handleCopy implements POST /api/v1/files/copy.
func (m *Module) handleCopy(w http.ResponseWriter, r *http.Request) {
	var req copyRequest
	if !decodeBody(w, r, &req, defaultJSONBytes) {
		return
	}
	if strings.TrimSpace(req.Root) == "" || req.From == "" || req.To == "" {
		httpapi.Fail(w, protocol.BadRequest("root、from、to 不能为空"))
		return
	}
	from, err := m.sb.resolve(req.Root, req.From)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !from.exists {
		httpapi.Fail(w, protocol.NotFound("源路径", from.virtual))
		return
	}
	if from.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("不能复制文件根目录"))
		return
	}
	if from.brokenLink || from.info.Mode()&os.ModeSymlink != 0 {
		httpapi.Fail(w, pathErr("不能复制符号链接"))
		return
	}
	to, err := m.sb.resolve(req.Root, req.To)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if to.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("不能复制到文件根目录本身"))
		return
	}
	if from.virtual == to.virtual {
		httpapi.Fail(w, protocol.BadRequest("源路径与目标路径相同"))
		return
	}
	if samePath(from.target, to.target) {
		httpapi.Fail(w, protocol.BadRequest("源路径与目标路径相同"))
		return
	}
	if from.info.IsDir() && within(from.target, to.target) {
		httpapi.Fail(w, protocol.BadRequest("不能把目录复制到自身内部"))
		return
	}
	if to.exists && (to.brokenLink || to.info.Mode()&os.ModeSymlink != 0) {
		httpapi.Fail(w, pathErr("不能覆盖符号链接"))
		return
	}
	if err := measureTree(from.target, false); err != nil {
		httpapi.Fail(w, err)
		return
	}
	overwrite := req.Overwrite != nil && *req.Overwrite
	if to.exists {
		if !overwrite {
			httpapi.Fail(w, protocol.Conflict("目标已存在"))
			return
		}
		if err := os.RemoveAll(to.host); err != nil {
			httpapi.Fail(w, mapFSError(err, to.virtual))
			return
		}
	}
	if err := ensureDir(filepath.Dir(to.target)); err != nil {
		httpapi.Fail(w, protocol.NotFound("上级目录", filepath.ToSlash(filepath.Dir(to.virtual))))
		return
	}
	if err := copyEntry(from.host, to.target, false); err != nil {
		httpapi.Fail(w, err)
		return
	}
	info, err := os.Lstat(to.target)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, to.virtual))
		return
	}
	httpapi.OK(w, itemFromInfo(to.rootReal, req.Root, to.virtual, to.target, info))
}

// measureTree enforces the copy limits from contract §10.2.
func measureTree(host string, allowLinks bool) error {
	const (
		maxFiles = 100_000
		maxBytes = int64(5 << 30)
	)
	files := 0
	var bytes int64
	err := filepath.WalkDir(host, func(_ string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if !allowLinks {
				return pathErr("目录中包含符号链接，不能复制")
			}
			files++
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		files++
		if info, infoErr := entry.Info(); infoErr == nil {
			bytes += info.Size()
		}
		if files > maxFiles || bytes > maxBytes {
			return protocol.BadRequest("复制内容超过上限（10 万文件 / 5 GiB）")
		}
		return nil
	})
	if err != nil {
		if os.IsPermission(err) {
			return forbiddenErr()
		}
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}

// copyEntry copies a file, directory tree or symlink. Symlinks are only
// allowed when allowLinks is true (trash cross-device moves); the user-facing
// copy endpoint rejects them.
func copyEntry(src, dst string, allowLinks bool) error {
	info, err := os.Lstat(src)
	if err != nil {
		if os.IsPermission(err) {
			return forbiddenErr()
		}
		return err
	}
	mode := info.Mode()
	switch {
	case mode&os.ModeSymlink != 0:
		if !allowLinks {
			return pathErr("不能复制符号链接")
		}
		target, readErr := os.Readlink(src)
		if readErr != nil {
			return readErr
		}
		if err := os.Symlink(target, dst); err != nil {
			return err
		}
		return nil
	case mode.IsDir():
		// Create with traversal bits so children can be written, then restore
		// the source mode when the tree is complete.
		if err := os.Mkdir(dst, mode.Perm()|0o700); err != nil {
			if !os.IsExist(err) {
				return err
			}
		}
		entries, readErr := os.ReadDir(src)
		if readErr != nil {
			return readErr
		}
		for _, entry := range entries {
			if err := copyEntry(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name()), allowLinks); err != nil {
				return err
			}
		}
		_ = os.Chmod(dst, mode.Perm())
		return nil
	case mode.IsRegular():
		return copyFile(src, dst)
	default:
		return protocol.BadRequest("不支持复制特殊文件")
	}
}

// handleChmod implements POST /api/v1/files/chmod.
func (m *Module) handleChmod(w http.ResponseWriter, r *http.Request) {
	var req chmodRequest
	if !decodeBody(w, r, &req, defaultJSONBytes) {
		return
	}
	if strings.TrimSpace(req.Root) == "" || req.Path == "" || req.Mode == "" {
		httpapi.Fail(w, protocol.BadRequest("root、path、mode 不能为空"))
		return
	}
	mode, err := parseOctalMode(req.Mode, 0)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	res, err := m.sb.resolve(req.Root, req.Path)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !res.exists {
		httpapi.Fail(w, protocol.NotFound("文件", res.virtual))
		return
	}
	if res.brokenLink || res.info.Mode()&os.ModeSymlink != 0 {
		httpapi.Fail(w, pathErr("不能修改符号链接的权限"))
		return
	}
	if err := os.Chmod(res.host, mode); err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	info, err := os.Lstat(res.host)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	httpapi.OK(w, itemFromInfo(res.rootReal, req.Root, res.virtual, res.host, info))
}

// handleDelete implements DELETE /api/v1/files (trash by default).
func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	rootName, virtual, ok := m.requireRootPath(w, r)
	if !ok {
		return
	}
	permanent, _, err := boolQuery(r, "permanent")
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	res, err := m.sb.resolve(rootName, virtual)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !res.exists {
		httpapi.Fail(w, protocol.NotFound("文件", res.virtual))
		return
	}
	if res.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("不能删除文件根目录"))
		return
	}
	if res.brokenLink {
		httpapi.Fail(w, pathErr("符号链接目标不存在或越界"))
		return
	}
	if permanent {
		if err := os.RemoveAll(res.host); err != nil {
			httpapi.Fail(w, mapFSError(err, res.virtual))
			return
		}
		httpapi.OK(w, map[string]any{"trashed": false, "path": res.virtual})
		return
	}
	trashID, err := m.moveToTrash(res)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, map[string]any{"trashed": true, "trashId": trashID, "path": res.virtual})
}

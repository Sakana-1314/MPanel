package files

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// trashMeta is stored next to the payload so the entry survives agent
// restarts: <dataDir>/trash/<YYYY-MM-DD>/<id>/{payload,meta.json}.
type trashMeta struct {
	ID           string `json:"id"`
	Root         string `json:"root"`
	OriginalPath string `json:"originalPath"`
	TrashedAt    string `json:"trashedAt"`
	SizeBytes    int64  `json:"sizeBytes"`
	Type         string `json:"type"`
}

type trashLocation struct {
	meta    trashMeta
	dir     string
	payload string
}

var trashIDPattern = regexp.MustCompile(`^tr_[a-f0-9]{8,32}$`)

func (m *Module) trashRoot() string {
	return filepath.Join(m.dataDir, "trash")
}

func newTrashID() string {
	buf := make([]byte, 9)
	if _, err := rand.Read(buf); err != nil {
		return "tr_" + strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return "tr_" + hex.EncodeToString(buf)
}

// moveToTrash moves one existing entry into the recycle bin and writes its
// metadata. Rename is used first; a cross-device fallback copies then removes.
func (m *Module) moveToTrash(res *resolved) (string, error) {
	size := pathSize(res.host, res.info)
	id, dir, payload, err := m.createTrashDir()
	if err != nil {
		return "", err
	}
	meta := trashMeta{
		ID:           id,
		Root:         res.root.name,
		OriginalPath: res.virtual,
		TrashedAt:    formatTime(time.Now()),
		SizeBytes:    size,
		Type:         fileTypeOf(res.info),
	}
	if err := movePath(res.host, payload); err != nil {
		_ = os.RemoveAll(dir)
		if os.IsPermission(err) {
			return "", forbiddenErr()
		}
		return "", err
	}
	data, err := json.Marshal(meta)
	if err != nil {
		_ = movePath(payload, res.host)
		_ = os.RemoveAll(dir)
		return "", err
	}
	if err := config.WriteFileAtomic(filepath.Join(dir, "meta.json"), data, 0o600); err != nil {
		if rollbackErr := movePath(payload, res.host); rollbackErr != nil {
			// Keep the payload in the recycle bin rather than deleting user data.
			return "", protocol.Errorf(protocol.CodeInternal, "创建回收站元数据失败，且回滚失败")
		}
		_ = os.RemoveAll(dir)
		return "", err
	}
	return id, nil
}

func (m *Module) createTrashDir() (id, dir, payload string, err error) {
	parent := filepath.Join(m.trashRoot(), time.Now().UTC().Format("2006-01-02"))
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", "", "", err
	}
	for attempt := 0; attempt < 8; attempt++ {
		id = newTrashID()
		dir = filepath.Join(parent, id)
		if mkErr := os.Mkdir(dir, 0o755); mkErr == nil {
			return id, dir, filepath.Join(dir, "payload"), nil
		} else if !os.IsExist(mkErr) {
			return "", "", "", mkErr
		}
	}
	return "", "", "", protocol.Errorf(protocol.CodeInternal, "无法创建回收站条目")
}

// pathSize measures a tree without following symlinks.
func pathSize(host string, info os.FileInfo) int64 {
	if info == nil {
		stat, err := os.Lstat(host)
		if err != nil {
			return 0
		}
		info = stat
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return info.Size()
	}
	var total int64
	walkErr := filepath.WalkDir(host, func(_ string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if stat, statErr := entry.Info(); statErr == nil {
			total += stat.Size()
		}
		return nil
	})
	if walkErr != nil {
		return 0
	}
	return total
}

// movePath renames src to dst, falling back to copy+delete across volumes.
func movePath(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyEntry(src, dst, true); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

func readTrashMeta(dir string) (trashMeta, error) {
	var meta trashMeta
	file, err := os.Open(filepath.Join(dir, "meta.json"))
	if err != nil {
		return meta, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 64*1024))
	if err != nil {
		return meta, err
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		return meta, err
	}
	if !trashIDPattern.MatchString(meta.ID) {
		return meta, protocol.BadRequest("回收站条目无效")
	}
	return meta, nil
}

// listTrashEntries scans the recycle bin, newest first.
func (m *Module) listTrashEntries() ([]TrashEntry, error) {
	root := m.trashRoot()
	dates, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return []TrashEntry{}, nil
		}
		return nil, err
	}
	entries := make([]TrashEntry, 0)
	for _, date := range dates {
		if !date.IsDir() {
			continue
		}
		children, readErr := os.ReadDir(filepath.Join(root, date.Name()))
		if readErr != nil {
			continue
		}
		for _, child := range children {
			if !child.IsDir() || !trashIDPattern.MatchString(child.Name()) {
				continue
			}
			meta, metaErr := readTrashMeta(filepath.Join(root, date.Name(), child.Name()))
			if metaErr != nil || meta.ID != child.Name() {
				continue
			}
			entries = append(entries, TrashEntry{
				ID:           meta.ID,
				Root:         meta.Root,
				OriginalPath: meta.OriginalPath,
				TrashedAt:    meta.TrashedAt,
				SizeBytes:    meta.SizeBytes,
				Type:         meta.Type,
			})
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].TrashedAt != entries[j].TrashedAt {
			return entries[i].TrashedAt > entries[j].TrashedAt
		}
		return entries[i].ID < entries[j].ID
	})
	return entries, nil
}

func (m *Module) findTrash(id string) (*trashLocation, error) {
	if !trashIDPattern.MatchString(id) {
		return nil, protocol.BadRequest("trashId 无效")
	}
	root := m.trashRoot()
	dates, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, protocol.NotFound("回收站条目", id)
		}
		return nil, err
	}
	for _, date := range dates {
		if !date.IsDir() {
			continue
		}
		dir := filepath.Join(root, date.Name(), id)
		if !within(root, dir) {
			continue
		}
		if info, statErr := os.Stat(dir); statErr != nil || !info.IsDir() {
			continue
		}
		meta, metaErr := readTrashMeta(dir)
		if metaErr != nil || meta.ID != id {
			continue
		}
		return &trashLocation{meta: meta, dir: dir, payload: filepath.Join(dir, "payload")}, nil
	}
	return nil, protocol.NotFound("回收站条目", id)
}

// handleTrashList implements GET /api/v1/files/trash.
func (m *Module) handleTrashList(w http.ResponseWriter, r *http.Request) {
	limit, err := pageLimit(r, 50, maxListLimit)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	offset, err := pageCursor(r)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	all, err := m.listTrashEntries()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	total := len(all)
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
	httpapi.OK(w, protocol.ListResult[TrashEntry]{
		Available:  true,
		Items:      all[offset:end],
		NextCursor: next,
		Total:      &total,
	})
}

// handleTrashRestore implements POST /api/v1/files/trash/restore.
func (m *Module) handleTrashRestore(w http.ResponseWriter, r *http.Request) {
	var req trashRestoreRequest
	if !decodeBody(w, r, &req, defaultJSONBytes) {
		return
	}
	if strings.TrimSpace(req.TrashID) == "" {
		httpapi.Fail(w, protocol.BadRequest("trashId 不能为空"))
		return
	}
	overwrite := req.Overwrite != nil && *req.Overwrite
	loc, err := m.findTrash(req.TrashID)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	res, err := m.sb.resolve(loc.meta.Root, loc.meta.OriginalPath)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if res.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("原路径是文件根目录，不能恢复"))
		return
	}
	if res.exists {
		if !overwrite {
			httpapi.Fail(w, &protocol.PanelError{
				Code:    protocol.CodeConflict,
				Message: "原路径已被占用",
				Hint:    "确认覆盖请传入 overwrite=true，或先移动现有条目。",
			})
			return
		}
		if res.info.Mode()&os.ModeSymlink != 0 {
			err = os.Remove(res.host)
		} else {
			err = os.RemoveAll(res.host)
		}
		if err != nil {
			httpapi.Fail(w, mapFSError(err, res.virtual))
			return
		}
	}
	// Restore at the lexical virtual path (res.host), not at a resolved link
	// target: parents were already verified to stay inside the root.
	parent := filepath.Dir(res.host)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	if err := movePath(loc.payload, res.host); err != nil {
		if os.IsPermission(err) {
			httpapi.Fail(w, forbiddenErr())
			return
		}
		httpapi.Fail(w, err)
		return
	}
	_ = os.RemoveAll(loc.dir)
	httpapi.OK(w, map[string]any{"restored": true, "path": res.virtual})
}

// handleTrashPurge implements DELETE /api/v1/files/trash/{id}.
func (m *Module) handleTrashPurge(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	loc, err := m.findTrash(id)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !within(m.trashRoot(), loc.dir) {
		httpapi.Fail(w, protocol.BadRequest("回收站条目无效"))
		return
	}
	if err := os.RemoveAll(loc.dir); err != nil {
		httpapi.Fail(w, mapFSError(err, "回收站条目"))
		return
	}
	httpapi.OK(w, map[string]any{"deleted": 1, "id": id})
}

// handleTrashEmpty implements POST /files/trash/empty and DELETE /files/trash.
func (m *Module) handleTrashEmpty(w http.ResponseWriter, r *http.Request) {
	var req trashEmptyRequest
	if r.Method == http.MethodPost {
		if !decodeBody(w, r, &req, defaultJSONBytes) {
			return
		}
	} else {
		req.All = true
	}
	if !req.All && len(req.TrashIDs) == 0 {
		httpapi.Fail(w, protocol.BadRequest("请提供 trashIds 或设置 all=true"))
		return
	}
	deleted := 0
	if req.All {
		root := m.trashRoot()
		dates, err := os.ReadDir(root)
		if err != nil {
			if os.IsNotExist(err) {
				httpapi.OK(w, map[string]any{"deleted": 0})
				return
			}
			httpapi.Fail(w, err)
			return
		}
		for _, date := range dates {
			if !date.IsDir() {
				continue
			}
			dateDir := filepath.Join(root, date.Name())
			children, readErr := os.ReadDir(dateDir)
			if readErr != nil {
				continue
			}
			for _, child := range children {
				if child.IsDir() && trashIDPattern.MatchString(child.Name()) {
					deleted++
				}
			}
			if removeErr := os.RemoveAll(dateDir); removeErr != nil {
				httpapi.Fail(w, mapFSError(removeErr, "回收站"))
				return
			}
		}
		httpapi.OK(w, map[string]any{"deleted": deleted})
		return
	}
	for _, id := range req.TrashIDs {
		loc, err := m.findTrash(strings.TrimSpace(id))
		if err != nil {
			continue // batch purge is idempotent
		}
		if !within(m.trashRoot(), loc.dir) {
			continue
		}
		if err := os.RemoveAll(loc.dir); err != nil {
			httpapi.Fail(w, mapFSError(err, "回收站条目"))
			return
		}
		deleted++
	}
	httpapi.OK(w, map[string]any{"deleted": deleted})
}

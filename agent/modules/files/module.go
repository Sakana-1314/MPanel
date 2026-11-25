package files

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/internal/httpapi"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

// Module implements the /api/v1/files feature set.
type Module struct {
	sb      *sandbox
	dataDir string
	runner  agent.Runner
	logger  *slog.Logger
}

// New returns an unregistered files module. It is not part of modules.All();
// the binary wires it in explicitly.
func New() *Module { return &Module{} }

var _ agent.Module = (*Module)(nil)

// Name implements agent.Module.
func (m *Module) Name() string { return "files" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	m.sb = newSandbox(ctx.Cfg.Agent.FilesRoots)
	m.dataDir = ctx.DataDir()
	if m.dataDir == "" {
		m.dataDir = filepath.Join(ctx.Cfg.Agent.BaseDir, "data", "agent")
	}
	m.runner = ctx.Runner
	if m.runner == nil {
		m.runner = agent.NewRunner()
	}
	m.logger = ctx.Logger
	if m.logger == nil {
		m.logger = slog.Default()
	}

	mux := ctx.Mux
	mux.HandleFunc("GET /api/v1/files/roots", m.handleRoots)
	// The frozen contract names the list route /files/list; the coordinator's
	// brief also requires /files. Both map to the same handler.
	mux.HandleFunc("GET /api/v1/files/list", m.handleList)
	mux.HandleFunc("GET /api/v1/files", m.handleList)
	mux.HandleFunc("GET /api/v1/files/stat", m.handleStat)
	mux.HandleFunc("GET /api/v1/files/read", m.handleRead)
	// Contract §10.2 uses PUT; the brief uses POST. Accept both.
	mux.HandleFunc("PUT /api/v1/files/write", m.handleWrite)
	mux.HandleFunc("POST /api/v1/files/write", m.handleWrite)
	mux.HandleFunc("POST /api/v1/files/mkdir", m.handleMkdir)
	mux.HandleFunc("POST /api/v1/files/rename", m.handleRename)
	mux.HandleFunc("POST /api/v1/files/copy", m.handleCopy)
	mux.HandleFunc("POST /api/v1/files/chmod", m.handleChmod)
	mux.HandleFunc("DELETE /api/v1/files", m.handleDelete)

	mux.HandleFunc("GET /api/v1/files/trash", m.handleTrashList)
	mux.HandleFunc("POST /api/v1/files/trash/restore", m.handleTrashRestore)
	mux.HandleFunc("POST /api/v1/files/trash/empty", m.handleTrashEmpty)
	mux.HandleFunc("DELETE /api/v1/files/trash", m.handleTrashEmpty)
	mux.HandleFunc("DELETE /api/v1/files/trash/{id}", m.handleTrashPurge)

	mux.HandleFunc("POST /api/v1/files/upload", m.handleUpload)
	mux.HandleFunc("GET /api/v1/files/download", m.handleDownload)
	mux.HandleFunc("POST /api/v1/files/archive", m.handleArchive)
	mux.HandleFunc("POST /api/v1/files/extract", m.handleExtract)
	mux.HandleFunc("GET /api/v1/files/search", m.handleSearch)
	return nil
}

const (
	defaultReadBytes   = 1 << 20   // 1 MiB
	maxReadBytes       = 8 << 20   // contract hard ceiling
	maxUploadBytes     = 100 << 20 // per file
	maxWriteBodyBytes  = 20 << 20  // base64 content inflation
	defaultJSONBytes   = 1 << 20
	defaultListLimit   = 100
	maxListLimit       = 200
	defaultSearchLimit = 100
	maxSearchLimit     = 500
	maxSearchFileBytes = 5 << 20
)

type writeRequest struct {
	Root          string `json:"root"`
	Path          string `json:"path"`
	Content       string `json:"content"`
	Encoding      string `json:"encoding,omitempty"`
	Create        *bool  `json:"create,omitempty"`
	Overwrite     *bool  `json:"overwrite,omitempty"`
	ExpectedMtime string `json:"expectedMtime,omitempty"`
	CreateBackup  *bool  `json:"createBackup,omitempty"`
}

type mkdirRequest struct {
	Root      string `json:"root"`
	Path      string `json:"path"`
	Recursive *bool  `json:"recursive,omitempty"`
	Mode      string `json:"mode,omitempty"`
}

type renameRequest struct {
	Root      string `json:"root"`
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite *bool  `json:"overwrite,omitempty"`
}

type copyRequest struct {
	Root      string `json:"root"`
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite *bool  `json:"overwrite,omitempty"`
}

type chmodRequest struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Mode string `json:"mode"`
}

type trashRestoreRequest struct {
	TrashID   string `json:"trashId"`
	Overwrite *bool  `json:"overwrite,omitempty"`
}

type trashEmptyRequest struct {
	TrashIDs []string `json:"trashIds,omitempty"`
	All      bool     `json:"all,omitempty"`
}

type archiveRequest struct {
	Root        string   `json:"root"`
	Paths       []string `json:"paths"`
	Destination string   `json:"destination"`
	Format      string   `json:"format"`
}

type extractRequest struct {
	Root        string `json:"root"`
	Path        string `json:"path"`
	Destination string `json:"destination"`
	Format      string `json:"format,omitempty"`
}

// decodeBody decodes a JSON request capped at limit bytes, writing a failure
// envelope on error. Empty bodies decode to the zero value.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any, limit int64) bool {
	if r.Body == nil {
		httpapi.Fail(w, protocol.BadRequest("请求体不能为空"))
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			httpapi.Fail(w, &protocol.PanelError{
				Code:    protocol.CodeBadRequest,
				Message: "请求体超过上限",
				Hint:    "写入接口请求体最大 20 MiB；更大的内容请使用分片上传接口。",
			})
			return false
		}
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "请求体不是合法 JSON",
		})
		return false
	}
	return true
}

// boolQuery reads the first present key, accepting the contract's
// true|false|1|0 and reporting malformed values.
func boolQuery(r *http.Request, keys ...string) (value bool, present bool, err error) {
	q := r.URL.Query()
	for _, key := range keys {
		raw := q.Get(key)
		if raw == "" {
			continue
		}
		switch strings.ToLower(raw) {
		case "true", "1":
			return true, true, nil
		case "false", "0":
			return false, true, nil
		default:
			return false, true, protocol.BadRequest("布尔参数 " + key + " 只能是 true/false/1/0")
		}
	}
	return false, false, nil
}

func intQuery(r *http.Request, key string) (int, bool, error) {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return 0, false, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, true, protocol.BadRequest("参数 " + key + " 必须是整数")
	}
	return value, true, nil
}

// pageLimit reads limit clamped into [1,max], applying def when absent.
func pageLimit(r *http.Request, def, max int) (int, error) {
	value, present, err := intQuery(r, "limit")
	if err != nil {
		return 0, err
	}
	if !present {
		return def, nil
	}
	if value < 1 {
		return 0, protocol.BadRequest("limit 必须不小于 1")
	}
	if value > max {
		value = max
	}
	return value, nil
}

// pageCursor parses the opaque offset cursor; anything non-numeric is invalid
// per contract §2.3.
func pageCursor(r *http.Request) (int, error) {
	cursor := r.URL.Query().Get("cursor")
	if cursor == "" {
		return 0, nil
	}
	offset := 0
	for _, ch := range cursor {
		if ch < '0' || ch > '9' {
			return 0, protocol.BadRequest("cursor 无效")
		}
		offset = offset*10 + int(ch-'0')
		if offset > 1_000_000 {
			return 0, protocol.BadRequest("cursor 无效")
		}
	}
	return offset, nil
}

func (m *Module) requireRootPath(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	q := r.URL.Query()
	root := strings.TrimSpace(q.Get("root"))
	if root == "" {
		httpapi.Fail(w, protocol.BadRequest("参数 root 不能为空"))
		return "", "", false
	}
	path := q.Get("path")
	if path == "" {
		path = "/"
	}
	return root, path, true
}

// ensurePathExistsDir is a small guard used by operations that need an
// existing directory (upload, archive destination parent, ...).
func ensureDir(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return protocol.BadRequest("目标必须是目录")
	}
	return nil
}

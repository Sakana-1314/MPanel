package core

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/sakana-1314/mpanel/core/config"
)

// staticHandler serves the built panel with SPA fallback and a generated
// /config.json when the deployment did not provide one.
type staticHandler struct {
	dir      string
	hasIndex bool
	log      *slog.Logger
}

func newStaticHandler(cfg *config.App, log *slog.Logger) *staticHandler {
	dir := cfg.System.WebDir
	if dir == "" {
		dir = filepath.Join(cfg.System.BaseDir, "web")
	}
	_, err := os.Stat(filepath.Join(dir, "index.html"))
	return &staticHandler{dir: dir, hasIndex: err == nil, log: log}
}

func (s *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/config.json" {
		s.serveRuntimeConfig(w, r)
		return
	}
	if !s.hasIndex {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "MPanel core 已启动，但未找到前端产物。\n请将 web/panel 的构建结果放到 "+s.dir+"，或在 conf/app.yaml 配置 web_dir。\nAPI 位于 /api/v1。\n")
		return
	}
	clean := path.Clean("/" + r.URL.Path)
	file := filepath.Join(s.dir, filepath.FromSlash(clean))
	if clean == "/" {
		file = filepath.Join(s.dir, "index.html")
	}
	if info, err := os.Stat(file); err == nil && !info.IsDir() {
		http.ServeFile(w, r, file)
		return
	}
	// SPA fallback.
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(s.dir, "index.html"))
}

func (s *staticHandler) serveRuntimeConfig(w http.ResponseWriter, r *http.Request) {
	file := filepath.Join(s.dir, "config.json")
	if data, err := os.ReadFile(file); err == nil {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
		return
	}
	payload := map[string]any{
		"appName":              "MPanel",
		"allowUserConnections": true,
	}
	if dbx := strings.TrimSpace(os.Getenv("MPANEL_DBX_URL")); dbx != "" {
		payload["dbxUrl"] = dbx
	}
	data, _ := json.MarshalIndent(payload, "", "  ")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(append(data, '\n'))
}

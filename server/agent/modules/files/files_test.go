package files

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

type testEnvelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	} `json:"error"`
}

type filesTestEnv struct {
	t    *testing.T
	srv  *httptest.Server
	root string
	data string
}

func newFilesTestEnv(t *testing.T) *filesTestEnv {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "root")
	data := filepath.Join(base, "data")
	for _, dir := range []string{root, data} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Agent{Agent: config.AgentSystem{
		BaseDir:    base,
		DataDir:    data,
		FilesRoots: []config.Root{{Name: "files", Path: root}},
	}}
	mux := http.NewServeMux()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := &agent.Context{
		Mux:    mux,
		Cfg:    cfg,
		Runner: agent.NewRunner(),
		Logger: logger,
	}
	if err := New().Register(ctx); err != nil {
		t.Fatalf("注册 files 模块失败: %v", err)
	}
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return &filesTestEnv{t: t, srv: server, root: root, data: data}
}

func (e *filesTestEnv) raw(method, path string, body io.Reader, contentType string) (int, http.Header, []byte) {
	e.t.Helper()
	request, err := http.NewRequest(method, e.srv.URL+path, body)
	if err != nil {
		e.t.Fatalf("构建请求失败: %v", err)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		e.t.Fatalf("%s %s 失败: %v", method, path, err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		e.t.Fatalf("读取响应失败: %v", err)
	}
	return response.StatusCode, response.Header, payload
}

func (e *filesTestEnv) call(method, path string, body any) (int, testEnvelope) {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			e.t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	status, _, payload := e.raw(method, path, reader, "application/json")
	var envelope testEnvelope
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &envelope); err != nil {
			e.t.Fatalf("%s %s 响应不是 JSON: %s", method, path, string(payload))
		}
	}
	return status, envelope
}

func (e *filesTestEnv) upload(query, filename, content string) (int, testEnvelope) {
	e.t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		e.t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		e.t.Fatal(err)
	}
	status, _, payload := e.raw("POST", "/api/v1/files/upload?"+query, &buffer, writer.FormDataContentType())
	var envelope testEnvelope
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &envelope); err != nil {
			e.t.Fatalf("上传响应不是 JSON: %s", string(payload))
		}
	}
	return status, envelope
}

func expectStatus(t *testing.T, status int, envelope testEnvelope, want int) {
	t.Helper()
	if status == want {
		return
	}
	detail := ""
	if envelope.Error != nil {
		detail = envelope.Error.Code + ": " + envelope.Error.Message
	}
	t.Fatalf("HTTP %d，期望 %d（%s）", status, want, detail)
}

func expectErrorCode(t *testing.T, status int, envelope testEnvelope, wantStatus int, wantCode protocol.ErrorCode) {
	t.Helper()
	expectStatus(t, status, envelope, wantStatus)
	if envelope.Error == nil || envelope.Error.Code != string(wantCode) {
		t.Fatalf("错误码不匹配：%+v，期望 %s", envelope.Error, wantCode)
	}
}

func decodeData[T any](t *testing.T, envelope testEnvelope) T {
	t.Helper()
	var value T
	if len(envelope.Data) == 0 {
		t.Fatalf("响应缺少 data")
	}
	if err := json.Unmarshal(envelope.Data, &value); err != nil {
		t.Fatalf("解析 data 失败: %v（%s）", err, string(envelope.Data))
	}
	return value
}

func TestFilesLifecycle(t *testing.T) {
	fx := newFilesTestEnv(t)

	status, envelope := fx.call("GET", "/api/v1/files/roots", nil)
	expectStatus(t, status, envelope, 200)
	roots := decodeData[protocol.ListResult[FileRoot]](t, envelope)
	if !roots.Available || len(roots.Items) != 1 || roots.Items[0].Name != "files" {
		t.Fatalf("roots 响应不正确: %+v", roots)
	}

	status, envelope = fx.call("POST", "/api/v1/files/mkdir", map[string]any{
		"root": "files", "path": "/docs", "recursive": true,
	})
	expectStatus(t, status, envelope, 200)
	dir := decodeData[FileItem](t, envelope)
	if dir.Type != fileTypeDirectory || dir.Path != "/docs" {
		t.Fatalf("mkdir 结果不正确: %+v", dir)
	}

	status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
		"root": "files", "path": "/docs/a.txt", "content": "hello world",
	})
	expectStatus(t, status, envelope, 200)
	written := decodeData[FileItem](t, envelope)
	if written.Size != int64(len("hello world")) || written.Type != fileTypeFile {
		t.Fatalf("write 结果不正确: %+v", written)
	}

	status, envelope = fx.call("GET", "/api/v1/files/stat?root=files&path=/docs/a.txt", nil)
	expectStatus(t, status, envelope, 200)
	if stat := decodeData[FileItem](t, envelope); stat.Name != "a.txt" {
		t.Fatalf("stat 结果不正确: %+v", stat)
	}

	status, envelope = fx.call("GET", "/api/v1/files/read?root=files&path=/docs/a.txt", nil)
	expectStatus(t, status, envelope, 200)
	read := decodeData[FileReadResult](t, envelope)
	if read.Content != "hello world" || read.Encoding != "utf8" || read.Truncated || read.IsBinary {
		t.Fatalf("read 结果不正确: %+v", read)
	}

	status, envelope = fx.call("GET", "/api/v1/files/read?root=files&path=/docs/a.txt&maxBytes=5", nil)
	expectStatus(t, status, envelope, 200)
	truncated := decodeData[FileReadResult](t, envelope)
	if truncated.Content != "hello" || !truncated.Truncated || truncated.Size != int64(len("hello world")) {
		t.Fatalf("maxBytes 截断结果不正确: %+v", truncated)
	}

	status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
		"root": "files", "path": "/docs/a.txt", "content": "x", "overwrite": false,
	})
	expectErrorCode(t, status, envelope, http.StatusConflict, protocol.CodeConflict)

	// createBackup keeps the previous content next to the file.
	status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
		"root": "files", "path": "/docs/a.txt", "content": "hello world 2", "createBackup": true,
	})
	expectStatus(t, status, envelope, 200)
	backup, err := os.ReadFile(filepath.Join(fx.root, "docs", "a.txt.bak"))
	if err != nil || string(backup) != "hello world" {
		t.Fatalf("createBackup 未保留旧内容: %q err=%v", string(backup), err)
	}

	status, envelope = fx.call("POST", "/api/v1/files/mkdir", map[string]any{
		"root": "files", "path": "/docs",
	})
	expectErrorCode(t, status, envelope, http.StatusConflict, protocol.CodeConflict)

	for _, route := range []string{
		"/api/v1/files/list?root=files&path=/docs",
		"/api/v1/files?root=files&path=/docs",
	} {
		status, envelope = fx.call("GET", route, nil)
		expectStatus(t, status, envelope, 200)
		list := decodeData[FileListResult](t, envelope)
		found := false
		for _, item := range list.Items {
			if item.Name == "a.txt" {
				found = true
			}
		}
		if !found || list.Path != "/docs" {
			t.Fatalf("%s 列表不正确: %+v", route, list)
		}
	}

	status, envelope = fx.call("POST", "/api/v1/files/rename", map[string]any{
		"root": "files", "from": "/docs/a.txt", "to": "/docs/b.txt",
	})
	expectStatus(t, status, envelope, 200)
	if renamed := decodeData[FileItem](t, envelope); renamed.Path != "/docs/b.txt" {
		t.Fatalf("rename 结果不正确: %+v", renamed)
	}

	status, envelope = fx.call("POST", "/api/v1/files/copy", map[string]any{
		"root": "files", "from": "/docs/b.txt", "to": "/docs/c.txt",
	})
	expectStatus(t, status, envelope, 200)
	if copied := decodeData[FileItem](t, envelope); copied.Path != "/docs/c.txt" {
		t.Fatalf("copy 结果不正确: %+v", copied)
	}

	status, envelope = fx.call("POST", "/api/v1/files/chmod", map[string]any{
		"root": "files", "path": "/docs/c.txt", "mode": "0600",
	})
	expectStatus(t, status, envelope, 200)
	chmodded := decodeData[FileItem](t, envelope)
	if runtime.GOOS != "windows" && chmodded.Mode != "0600" {
		t.Fatalf("chmod 后 mode=%q，期望 0600", chmodded.Mode)
	}

	// Trash + restore b.txt.
	status, envelope = fx.call("DELETE", "/api/v1/files?root=files&path=/docs/b.txt", nil)
	expectStatus(t, status, envelope, 200)
	deleted := decodeData[map[string]any](t, envelope)
	trashID, _ := deleted["trashId"].(string)
	if deleted["trashed"] != true || trashID == "" || deleted["path"] != "/docs/b.txt" {
		t.Fatalf("移入回收站结果不正确: %+v", deleted)
	}
	matches, _ := filepath.Glob(filepath.Join(fx.data, "trash", "*", trashID, "meta.json"))
	if len(matches) != 1 {
		t.Fatalf("回收站布局不正确，未找到 %s/meta.json", trashID)
	}

	status, envelope = fx.call("GET", "/api/v1/files/stat?root=files&path=/docs/b.txt", nil)
	expectErrorCode(t, status, envelope, http.StatusNotFound, protocol.CodeNotFound)

	status, envelope = fx.call("GET", "/api/v1/files/trash", nil)
	expectStatus(t, status, envelope, 200)
	trash := decodeData[protocol.ListResult[TrashEntry]](t, envelope)
	if !trash.Available || len(trash.Items) != 1 {
		t.Fatalf("回收站列表不正确: %+v", trash)
	}
	if entry := trash.Items[0]; entry.OriginalPath != "/docs/b.txt" || entry.Root != "files" || entry.Type != fileTypeFile {
		t.Fatalf("回收站条目不正确: %+v", entry)
	}

	status, envelope = fx.call("POST", "/api/v1/files/trash/restore", map[string]any{"trashId": trashID})
	expectStatus(t, status, envelope, 200)
	restored := decodeData[map[string]any](t, envelope)
	if restored["restored"] != true || restored["path"] != "/docs/b.txt" {
		t.Fatalf("恢复结果不正确: %+v", restored)
	}
	status, envelope = fx.call("GET", "/api/v1/files/stat?root=files&path=/docs/b.txt", nil)
	expectStatus(t, status, envelope, 200)

	// Permanent delete.
	status, envelope = fx.call("DELETE", "/api/v1/files?root=files&path=/docs/c.txt&permanent=true", nil)
	expectStatus(t, status, envelope, 200)
	if permanent := decodeData[map[string]any](t, envelope); permanent["trashed"] != false {
		t.Fatalf("永久删除结果不正确: %+v", permanent)
	}
	if _, err := os.Stat(filepath.Join(fx.root, "docs", "c.txt")); !os.IsNotExist(err) {
		t.Fatalf("永久删除后文件仍存在: %v", err)
	}

	// Trash again, then purge a single entry.
	status, envelope = fx.call("DELETE", "/api/v1/files?root=files&path=/docs/b.txt", nil)
	expectStatus(t, status, envelope, 200)
	trashID = decodeData[map[string]any](t, envelope)["trashId"].(string)
	status, envelope = fx.call("DELETE", "/api/v1/files/trash/"+trashID, nil)
	expectStatus(t, status, envelope, 200)
	if purged := decodeData[map[string]any](t, envelope); purged["deleted"] != float64(1) {
		t.Fatalf("彻底删除结果不正确: %+v", purged)
	}

	// Write it again, delete, then empty the whole bin.
	status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
		"root": "files", "path": "/docs/b.txt", "content": "again",
	})
	expectStatus(t, status, envelope, 200)
	status, envelope = fx.call("DELETE", "/api/v1/files?root=files&path=/docs/b.txt", nil)
	expectStatus(t, status, envelope, 200)
	status, envelope = fx.call("POST", "/api/v1/files/trash/empty", map[string]any{"all": true})
	expectStatus(t, status, envelope, 200)
	if emptied := decodeData[map[string]any](t, envelope); emptied["deleted"] != float64(1) {
		t.Fatalf("清空回收站结果不正确: %+v", emptied)
	}
	status, envelope = fx.call("GET", "/api/v1/files/trash", nil)
	expectStatus(t, status, envelope, 200)
	if trash := decodeData[protocol.ListResult[TrashEntry]](t, envelope); len(trash.Items) != 0 {
		t.Fatalf("清空后回收站仍非空: %+v", trash)
	}
	status, envelope = fx.call("DELETE", "/api/v1/files/trash", nil)
	expectStatus(t, status, envelope, 200)
	if cleared := decodeData[map[string]any](t, envelope); cleared["deleted"] != float64(0) {
		t.Fatalf("DELETE /files/trash 清空结果不正确: %+v", cleared)
	}

	// Root directory itself is protected.
	status, envelope = fx.call("DELETE", "/api/v1/files?root=files&path=/", nil)
	expectErrorCode(t, status, envelope, http.StatusBadRequest, protocol.CodeBadRequest)
}

func TestFilesBinaryAndSearch(t *testing.T) {
	fx := newFilesTestEnv(t)

	binary := []byte{0x00, 0x01, 0x02, 0xff}
	status, envelope := fx.call("PUT", "/api/v1/files/write", map[string]any{
		"root": "files", "path": "/bin.dat", "content": base64.StdEncoding.EncodeToString(binary), "encoding": "base64",
	})
	expectStatus(t, status, envelope, 200)

	status, envelope = fx.call("GET", "/api/v1/files/read?root=files&path=/bin.dat", nil)
	expectErrorCode(t, status, envelope, http.StatusBadRequest, protocol.CodeBadRequest)

	status, envelope = fx.call("GET", "/api/v1/files/read?root=files&path=/bin.dat&encoding=base64", nil)
	expectStatus(t, status, envelope, 200)
	read := decodeData[FileReadResult](t, envelope)
	if !read.IsBinary || read.Encoding != "base64" || read.Content != base64.StdEncoding.EncodeToString(binary) {
		t.Fatalf("base64 读取结果不正确: %+v", read)
	}

	status, envelope = fx.call("POST", "/api/v1/files/mkdir", map[string]any{
		"root": "files", "path": "/notes", "recursive": true,
	})
	expectStatus(t, status, envelope, 200)
	for path, content := range map[string]string{
		"/notes/readme.md":  "hello zcode search",
		"/notes/app.log":    "zcode log line",
		"/notes/other.txt":  "nothing here",
		"/notes/.secret.md": "hidden zcode",
	} {
		status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
			"root": "files", "path": path, "content": content,
		})
		expectStatus(t, status, envelope, 200)
	}

	status, envelope = fx.call("GET", "/api/v1/files/search?root=files&path=/notes&q=*.md&mode=name", nil)
	expectStatus(t, status, envelope, 200)
	search := decodeData[FileSearchResult](t, envelope)
	if len(search.Items) != 1 || search.Items[0].Path != "/notes/readme.md" || search.Truncated {
		t.Fatalf("glob 搜索不正确: %+v", search)
	}

	status, envelope = fx.call("GET", "/api/v1/files/search?root=files&path=/notes&q=*.md&mode=name&includeHidden=true", nil)
	expectStatus(t, status, envelope, 200)
	if hidden := decodeData[FileSearchResult](t, envelope); len(hidden.Items) != 2 {
		t.Fatalf("includeHidden 搜索不正确: %+v", hidden)
	}

	status, envelope = fx.call("GET", "/api/v1/files/search?root=files&path=/notes&q=zcode&mode=content", nil)
	expectStatus(t, status, envelope, 200)
	contentHits := decodeData[FileSearchResult](t, envelope)
	if len(contentHits.Items) != 2 || contentHits.Query != "zcode" {
		t.Fatalf("内容搜索不正确: %+v", contentHits)
	}

	status, envelope = fx.call("GET", "/api/v1/files/search?root=files&path=/notes&q=zcode&mode=content&limit=1", nil)
	expectStatus(t, status, envelope, 200)
	limited := decodeData[FileSearchResult](t, envelope)
	if len(limited.Items) != 1 || !limited.Truncated {
		t.Fatalf("搜索结果上限/truncated 不正确: %+v", limited)
	}
}

func TestFilesUploadDownload(t *testing.T) {
	fx := newFilesTestEnv(t)
	status, envelope := fx.call("POST", "/api/v1/files/mkdir", map[string]any{
		"root": "files", "path": "/up", "recursive": true,
	})
	expectStatus(t, status, envelope, 200)

	status, envelope = fx.upload("root=files&path=/up", "hello.txt", "upload-body")
	expectStatus(t, status, envelope, http.StatusCreated)
	uploaded := decodeData[FileItem](t, envelope)
	if uploaded.Name != "hello.txt" || uploaded.Size != int64(len("upload-body")) {
		t.Fatalf("上传结果不正确: %+v", uploaded)
	}

	status, header, body := fx.raw("GET", "/api/v1/files/download?root=files&path=/up/hello.txt", nil, "")
	if status != 200 || string(body) != "upload-body" {
		t.Fatalf("下载失败: status=%d body=%q", status, string(body))
	}
	if !strings.Contains(header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("缺少 Content-Disposition: %q", header.Get("Content-Disposition"))
	}

	request, err := http.NewRequest("GET", fx.srv.URL+"/api/v1/files/download?root=files&path=/up/hello.txt", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=0-3")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	rangeBody, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusPartialContent || string(rangeBody) != "uplo" {
		t.Fatalf("Range 下载不正确: status=%d body=%q", response.StatusCode, string(rangeBody))
	}

	status, envelope = fx.upload("root=files&path=/up", "hello.txt", "second")
	expectErrorCode(t, status, envelope, http.StatusConflict, protocol.CodeConflict)

	status, envelope = fx.upload("root=files&path=/up&overwrite=true", "hello.txt", "second")
	expectStatus(t, status, envelope, http.StatusCreated)
	if replaced := decodeData[FileItem](t, envelope); replaced.Size != int64(len("second")) {
		t.Fatalf("覆盖上传结果不正确: %+v", replaced)
	}

	status, envelope = fx.upload("root=files&path=/up&conflict=rename", "hello.txt", "third")
	expectStatus(t, status, envelope, http.StatusCreated)
	if renamed := decodeData[FileItem](t, envelope); renamed.Name != "hello (1).txt" {
		t.Fatalf("重命名上传结果不正确: %+v", renamed)
	}

	status, envelope = fx.upload("root=files&path=/nope", "x.txt", "x")
	expectErrorCode(t, status, envelope, http.StatusNotFound, protocol.CodeNotFound)
}

func TestTrashRestoreOverwrite(t *testing.T) {
	fx := newFilesTestEnv(t)
	status, envelope := fx.call("POST", "/api/v1/files/mkdir", map[string]any{
		"root": "files", "path": "/rt", "recursive": true,
	})
	expectStatus(t, status, envelope, 200)
	status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
		"root": "files", "path": "/rt/x.txt", "content": "old",
	})
	expectStatus(t, status, envelope, 200)

	status, envelope = fx.call("DELETE", "/api/v1/files?root=files&path=/rt/x.txt", nil)
	expectStatus(t, status, envelope, 200)
	trashID := decodeData[map[string]any](t, envelope)["trashId"].(string)

	status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
		"root": "files", "path": "/rt/x.txt", "content": "new",
	})
	expectStatus(t, status, envelope, 200)

	status, envelope = fx.call("POST", "/api/v1/files/trash/restore", map[string]any{"trashId": trashID})
	expectErrorCode(t, status, envelope, http.StatusConflict, protocol.CodeConflict)

	status, envelope = fx.call("POST", "/api/v1/files/trash/restore", map[string]any{
		"trashId": trashID, "overwrite": true,
	})
	expectStatus(t, status, envelope, 200)
	status, envelope = fx.call("GET", "/api/v1/files/read?root=files&path=/rt/x.txt", nil)
	expectStatus(t, status, envelope, 200)
	if content := decodeData[FileReadResult](t, envelope); content.Content != "old" {
		t.Fatalf("覆盖恢复后内容不正确: %+v", content)
	}
}

func TestFilesArchiveExtract(t *testing.T) {
	fx := newFilesTestEnv(t)
	status, envelope := fx.call("POST", "/api/v1/files/mkdir", map[string]any{
		"root": "files", "path": "/pack", "recursive": true,
	})
	expectStatus(t, status, envelope, 200)
	for name, content := range map[string]string{"a.txt": "alpha", "b.txt": "beta"} {
		status, envelope = fx.call("PUT", "/api/v1/files/write", map[string]any{
			"root": "files", "path": "/pack/" + name, "content": content,
		})
		expectStatus(t, status, envelope, 200)
	}

	status, envelope = fx.call("POST", "/api/v1/files/archive", map[string]any{
		"root": "files", "paths": []string{"/pack"}, "destination": "/pack.tar.gz", "format": "tar.gz",
	})
	if status == http.StatusServiceUnavailable {
		t.Skip("当前主机没有 tar，跳过 tar.gz 归档测试")
	}
	if status != 200 {
		details := map[string]any(nil)
		if envelope.Error != nil {
			details = envelope.Error.Details
		}
		t.Fatalf("tar.gz 归档失败: %+v details=%v", envelope.Error, details)
	}
	expectStatus(t, status, envelope, 200)
	archive := decodeData[FileArchiveResult](t, envelope)
	if archive.Format != "tar.gz" || archive.Path != "/pack.tar.gz" || archive.Entries < 2 || archive.SizeBytes <= 0 {
		t.Fatalf("tar.gz 归档结果不正确: %+v", archive)
	}

	status, envelope = fx.call("POST", "/api/v1/files/extract", map[string]any{
		"root": "files", "path": "/pack.tar.gz", "destination": "/out",
	})
	expectStatus(t, status, envelope, 200)
	extracted := decodeData[FileExtractResult](t, envelope)
	if extracted.Destination != "/out" || extracted.Entries < 2 {
		t.Fatalf("tar.gz 解压结果不正确: %+v", extracted)
	}
	status, envelope = fx.call("GET", "/api/v1/files/read?root=files&path=/out/pack/a.txt", nil)
	expectStatus(t, status, envelope, 200)
	if content := decodeData[FileReadResult](t, envelope); content.Content != "alpha" {
		t.Fatalf("解压文件内容不正确: %+v", content)
	}

	// zip is written natively, so it works without an external binary.
	status, envelope = fx.call("POST", "/api/v1/files/archive", map[string]any{
		"root": "files", "paths": []string{"/pack"}, "destination": "/pack.zip", "format": "zip",
	})
	expectStatus(t, status, envelope, 200)
	zipArchive := decodeData[FileArchiveResult](t, envelope)
	if zipArchive.Format != "zip" || zipArchive.Entries < 2 {
		t.Fatalf("zip 归档结果不正确: %+v", zipArchive)
	}
	status, envelope = fx.call("POST", "/api/v1/files/extract", map[string]any{
		"root": "files", "path": "/pack.zip", "destination": "/zipout",
	})
	expectStatus(t, status, envelope, 200)
	status, envelope = fx.call("GET", "/api/v1/files/read?root=files&path=/zipout/pack/b.txt", nil)
	expectStatus(t, status, envelope, 200)
	if content := decodeData[FileReadResult](t, envelope); content.Content != "beta" {
		t.Fatalf("zip 解压文件内容不正确: %+v", content)
	}

	// zip-slip / tar-slip: "../evil.txt" must be rejected before writing.
	slipPath := filepath.Join(fx.root, "slip.tar.gz")
	writeSlipArchive(t, slipPath)
	outside := filepath.Join(filepath.Dir(fx.root), "evil.txt")
	_ = os.Remove(outside)
	status, envelope = fx.call("POST", "/api/v1/files/extract", map[string]any{
		"root": "files", "path": "/slip.tar.gz", "destination": "/slipout",
	})
	expectErrorCode(t, status, envelope, http.StatusBadRequest, protocol.CodeBadRequest)
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("zip-slip 逃逸写入了根外文件: %v", err)
	}
}

func writeSlipArchive(t *testing.T, path string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	payload := []byte("evil")
	if err := tarWriter.WriteHeader(&tar.Header{
		Name:     "../evil.txt",
		Mode:     0o644,
		Size:     int64(len(payload)),
		Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

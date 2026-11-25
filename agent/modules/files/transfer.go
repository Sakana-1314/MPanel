package files

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/sakana-1314/mpanel/core/httpapi"
	"github.com/sakana-1314/mpanel/core/protocol"
)

// handleUpload implements POST /api/v1/files/upload. The body is streamed to a
// temporary file in the destination directory; nothing is buffered in memory.
func (m *Module) handleUpload(w http.ResponseWriter, r *http.Request) {
	rootName, virtual, ok := m.requireRootPath(w, r)
	if !ok {
		return
	}
	overwrite, _, err := boolQuery(r, "overwrite")
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	conflict := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("conflict")))
	if conflict == "" {
		if overwrite {
			conflict = "overwrite"
		} else {
			conflict = "fail"
		}
	}
	switch conflict {
	case "overwrite", "skip", "rename", "fail":
	default:
		httpapi.Fail(w, protocol.BadRequest("conflict 只支持 overwrite/skip/rename"))
		return
	}
	res, err := m.sb.resolve(rootName, virtual)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !res.exists || res.brokenLink {
		httpapi.Fail(w, protocol.NotFound("目录", res.virtual))
		return
	}
	if !isDirTarget(res) {
		httpapi.Fail(w, protocol.BadRequest("上传目标必须是已存在的目录"))
		return
	}
	// The multipart envelope overhead is small; the per-file ceiling is 100 MiB.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+8<<20)
	reader, err := r.MultipartReader()
	if err != nil {
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "上传请求必须是 multipart/form-data",
			Hint:    "请使用 multipart 字段 file 上传单个文件。",
		})
		return
	}
	var item *FileItem
	for {
		part, partErr := reader.NextPart()
		if errors.Is(partErr, io.EOF) {
			break
		}
		if partErr != nil {
			httpapi.Fail(w, uploadReadError(partErr))
			return
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		name, nameErr := sanitizeUploadName(part.FileName())
		if nameErr != nil {
			_ = part.Close()
			httpapi.Fail(w, nameErr)
			return
		}
		saved, saveErr := m.saveUpload(part, res, rootName, name, conflict)
		_ = part.Close()
		if saveErr != nil {
			httpapi.Fail(w, saveErr)
			return
		}
		item = &saved
		break
	}
	if item == nil {
		httpapi.Fail(w, protocol.BadRequest("缺少 multipart 文件字段 file"))
		return
	}
	httpapi.Created(w, *item)
}

func uploadReadError(err error) error {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "上传内容超过上限",
			Hint:    "单个文件最大 100 MiB（MPANEL_MAX_UPLOAD_BYTES）。",
		}
	}
	return &protocol.PanelError{
		Code:    protocol.CodeBadRequest,
		Message: "读取上传内容失败",
		Hint:    "请确认请求体是合法的 multipart/form-data。",
	}
}

// sanitizeUploadName strips any client path and validates the final basename.
func sanitizeUploadName(raw string) (string, error) {
	name := strings.ReplaceAll(raw, "\\", "/")
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." {
		return "", protocol.BadRequest("上传文件名无效")
	}
	if err := validateSegment(name); err != nil {
		return "", err
	}
	return name, nil
}

func (m *Module) saveUpload(part io.Reader, dirRes *resolved, rootName, name, conflict string) (FileItem, error) {
	dirHost := dirRes.target
	virtual := joinVirtual(dirRes.virtual, name)
	target := filepath.Join(dirHost, name)
	if !within(dirRes.rootReal, target) {
		return FileItem{}, pathErr("上传目标越界")
	}
	info, statErr := os.Lstat(target)
	exists := statErr == nil
	if exists && info.IsDir() {
		return FileItem{}, protocol.Conflict("同名目录已存在，不能上传文件")
	}
	switch {
	case exists && conflict == "fail":
		return FileItem{}, protocol.Conflict("目标文件已存在")
	case exists && conflict == "skip":
		// Drain the part so the client can finish the request cleanly.
		_, _ = io.Copy(io.Discard, io.LimitReader(part, maxUploadBytes+1))
		return itemFromInfo(dirRes.rootReal, rootName, virtual, target, info), nil
	case exists && conflict == "rename":
		unique, err := uniqueUploadName(dirHost, name)
		if err != nil {
			return FileItem{}, err
		}
		name = unique
		virtual = joinVirtual(dirRes.virtual, name)
		target = filepath.Join(dirHost, name)
	}

	tmp, err := os.CreateTemp(dirHost, ".mpanel-upload-*")
	if err != nil {
		return FileItem{}, mapFSError(err, virtual)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	written, copyErr := io.Copy(tmp, io.LimitReader(part, maxUploadBytes+1))
	if copyErr != nil {
		cleanup()
		return FileItem{}, uploadReadError(copyErr)
	}
	if written > maxUploadBytes {
		cleanup()
		return FileItem{}, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "上传文件超过 100 MiB 上限",
			Hint:    "请压缩或分片后再上传。",
		}
	}
	mode := os.FileMode(0o644)
	if exists && info.Mode().IsRegular() {
		mode = info.Mode().Perm()
	}
	if err := tmp.Chmod(mode); err != nil {
		cleanup()
		return FileItem{}, err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return FileItem{}, err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return FileItem{}, err
	}
	if err := os.Rename(tmpName, target); err != nil {
		if exists {
			// Windows cannot replace a read-only file; clear it and retry once.
			if removeErr := os.Remove(target); removeErr == nil {
				err = os.Rename(tmpName, target)
			}
		}
		if err != nil {
			_ = os.Remove(tmpName)
			return FileItem{}, mapFSError(err, virtual)
		}
	}
	savedInfo, err := os.Lstat(target)
	if err != nil {
		return FileItem{}, mapFSError(err, virtual)
	}
	return itemFromInfo(dirRes.rootReal, rootName, virtual, target, savedInfo), nil
}

func uniqueUploadName(dirHost, name string) (string, error) {
	base := name
	ext := ""
	if idx := strings.LastIndex(name, "."); idx > 0 && idx < len(name)-1 {
		base, ext = name[:idx], name[idx:]
	}
	for i := 1; i <= 10_000; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Lstat(filepath.Join(dirHost, candidate)); os.IsNotExist(err) {
			return candidate, nil
		}
	}
	return "", protocol.Conflict("无法生成唯一的文件名")
}

// handleDownload implements GET /api/v1/files/download as a raw stream.
func (m *Module) handleDownload(w http.ResponseWriter, r *http.Request) {
	rootName, virtual, ok := m.requireRootPath(w, r)
	if !ok {
		return
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
		httpapi.Fail(w, protocol.BadRequest("不能下载目录"))
		return
	}
	if !info.Mode().IsRegular() {
		httpapi.Fail(w, protocol.BadRequest("只能下载普通文件"))
		return
	}
	file, err := os.Open(res.host)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}
	defer file.Close()
	name := virtualName(res.virtual)
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	header := w.Header()
	header.Set("Content-Type", contentType)
	header.Set("Content-Disposition", contentDisposition(name))
	header.Set("Cache-Control", "no-store")
	header.Set("X-MPanel-Api-Version", "1")
	header.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

func contentDisposition(name string) string {
	var ascii strings.Builder
	for i := 0; i < len(name); i++ {
		b := name[i]
		if b < 0x20 || b > 0x7e || b == '"' || b == '\\' {
			ascii.WriteByte('_')
		} else {
			ascii.WriteByte(b)
		}
	}
	if ascii.Len() == 0 {
		ascii.WriteByte('_')
	}
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, ascii.String(), encodeRFC5987(name))
}

func encodeRFC5987(value string) string {
	const allowed = "!#$&+-.^_`|~"
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		b := value[i]
		if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ||
			strings.IndexByte(allowed, b) >= 0 {
			out.WriteByte(b)
			continue
		}
		fmt.Fprintf(&out, "%%%02X", b)
	}
	return out.String()
}

// isBinaryData uses NUL bytes and the ratio of control characters in a sample
// to classify content that the utf8 reader must not return.
func isBinaryData(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	sample := data
	if len(sample) > 8000 {
		sample = sample[:8000]
	}
	for _, b := range sample {
		if b == 0 {
			return true
		}
	}
	if utf8.Valid(sample) {
		return false
	}
	controls := 0
	for _, b := range sample {
		if b < 0x20 && b != '\t' && b != '\n' && b != '\r' && b != '\f' {
			controls++
		}
	}
	return controls*20 >= len(sample)
}

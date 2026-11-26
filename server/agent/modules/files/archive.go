package files

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

const (
	maxArchiveEntries = 100_000
	maxArchiveBytes   = int64(5 << 30) // 5 GiB
	archiveTimeout    = 10 * time.Minute
	archiveOutputCap  = 4 * 1024
)

type archiveSource struct {
	virtual string
	rel     string
	host    string
	target  string
	isDir   bool
}

func normalizeArchiveFormat(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "tar.gz", "tgz":
		return "tar.gz", nil
	case "tar":
		return "tar", nil
	case "zip":
		return "zip", nil
	default:
		return "", protocol.BadRequest("format 只支持 zip、tar、tar.gz")
	}
}

// handleArchive implements POST /api/v1/files/archive.
func (m *Module) handleArchive(w http.ResponseWriter, r *http.Request) {
	var req archiveRequest
	if !decodeBody(w, r, &req, defaultJSONBytes) {
		return
	}
	if strings.TrimSpace(req.Root) == "" {
		httpapi.Fail(w, protocol.BadRequest("root 不能为空"))
		return
	}
	if len(req.Paths) == 0 {
		httpapi.Fail(w, protocol.BadRequest("paths 不能为空"))
		return
	}
	if strings.TrimSpace(req.Destination) == "" {
		httpapi.Fail(w, protocol.BadRequest("destination 不能为空"))
		return
	}
	format, err := normalizeArchiveFormat(req.Format)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	dest, err := m.sb.resolve(req.Root, req.Destination)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if dest.virtual == "/" {
		httpapi.Fail(w, protocol.BadRequest("归档目标不能是文件根目录"))
		return
	}
	if dest.exists {
		httpapi.Fail(w, protocol.Conflict("归档目标已存在"))
		return
	}
	if err := ensureDir(filepath.Dir(dest.target)); err != nil {
		httpapi.Fail(w, protocol.NotFound("归档目标上级目录", filepath.ToSlash(filepath.Dir(dest.virtual))))
		return
	}

	sources := make([]archiveSource, 0, len(req.Paths))
	for _, raw := range req.Paths {
		src, srcErr := m.sb.resolve(req.Root, raw)
		if srcErr != nil {
			httpapi.Fail(w, srcErr)
			return
		}
		if !src.exists || src.brokenLink {
			httpapi.Fail(w, protocol.NotFound("源路径", src.virtual))
			return
		}
		sources = append(sources, archiveSource{
			virtual: src.virtual,
			rel:     src.rel,
			host:    src.host,
			target:  src.target,
			isDir:   src.info.IsDir() && src.info.Mode()&os.ModeSymlink == 0,
		})
	}
	sources = pruneNestedSources(sources)
	for _, src := range sources {
		if samePath(dest.target, src.target) || (src.isDir && within(src.target, dest.target)) {
			httpapi.Fail(w, protocol.BadRequest("归档目标不能位于被归档的目录内"))
			return
		}
	}
	parent := filepath.Dir(dest.target)
	tmp, err := os.CreateTemp(parent, ".mpanel-archive-*")
	if err != nil {
		httpapi.Fail(w, mapFSError(err, dest.virtual))
		return
	}
	tmpName := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpName)

	entries := 0
	switch format {
	case "zip":
		entries, err = writeArchiveZip(tmpName, sources)
		if err != nil {
			httpapi.Fail(w, err)
			return
		}
	default:
		entries = countArchiveEntries(sources)
		if entries > maxArchiveEntries {
			httpapi.Fail(w, protocol.BadRequest("归档条目超过 10 万上限"))
			return
		}
		if err := m.runTarArchive(r, format, tmpName, dest.rootReal, sources); err != nil {
			httpapi.Fail(w, err)
			return
		}
	}
	if err := os.Rename(tmpName, dest.target); err != nil {
		httpapi.Fail(w, mapFSError(err, dest.virtual))
		return
	}
	info, err := os.Lstat(dest.target)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, dest.virtual))
		return
	}
	httpapi.OK(w, FileArchiveResult{
		Path:      dest.virtual,
		Format:    format,
		SizeBytes: info.Size(),
		Entries:   entries,
	})
}

// pruneNestedSources drops sources already covered by a parent directory.
func pruneNestedSources(sources []archiveSource) []archiveSource {
	sort.SliceStable(sources, func(i, j int) bool {
		return len(sources[i].virtual) < len(sources[j].virtual)
	})
	kept := make([]archiveSource, 0, len(sources))
	for _, src := range sources {
		covered := false
		for _, parent := range kept {
			if samePath(parent.target, src.target) {
				covered = true
				break
			}
			if parent.isDir && within(parent.target, src.target) {
				covered = true
				break
			}
		}
		if !covered {
			kept = append(kept, src)
		}
	}
	return kept
}

func countArchiveEntries(sources []archiveSource) int {
	count := 0
	for _, src := range sources {
		_ = filepath.WalkDir(src.host, func(_ string, _ fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			count++
			if count > maxArchiveEntries {
				return filepath.SkipAll
			}
			return nil
		})
		if count > maxArchiveEntries {
			return count
		}
	}
	return count
}

// runTarArchive builds tar/tar.gz through the agent Runner with an argument
// array (never a shell). The archive is written to tmpName, then renamed.
func (m *Module) runTarArchive(r *http.Request, format, tmpName, rootReal string, sources []archiveSource) error {
	args := make([]string, 0, len(sources)+4)
	if format == "tar.gz" {
		args = append(args, "-czf", tmpName)
	} else {
		args = append(args, "-cf", tmpName)
	}
	args = append(args, "-C", rootReal)
	for _, src := range sources {
		rel := src.rel
		if rel == "" {
			rel = "."
		}
		args = append(args, filepath.FromSlash(rel))
	}
	// GNU tar treats a colon in the archive path as a remote host (Windows
	// drive letters). --force-local disables that; bsdtar rejects the flag, so
	// retry without it when the option is unknown.
	localArgs := append([]string{"--force-local"}, args...)
	result, err := m.runner.RunTimeout(r.Context(), archiveTimeout, "tar", localArgs...)
	if err != nil {
		return protocol.Unavailable("系统中无法执行 tar", "请安装 GNU tar 或 bsdtar，或改用 zip 格式打包。")
	}
	if result.Code != 0 && unknownTarOption(result) {
		result, err = m.runner.RunTimeout(r.Context(), archiveTimeout, "tar", args...)
		if err != nil {
			return protocol.Unavailable("系统中无法执行 tar", "请安装 GNU tar 或 bsdtar，或改用 zip 格式打包。")
		}
	}
	if result.Code != 0 {
		output := result.Stderr
		if strings.TrimSpace(output) == "" {
			output = result.Stdout
		}
		return archiveOutputError("tar 打包失败", output)
	}
	return nil
}

func unknownTarOption(result agent.Result) bool {
	text := strings.ToLower(result.Stderr + "\n" + result.Stdout)
	for _, marker := range []string{"unrecognized option", "unknown option", "illegal option", "invalid option"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func archiveOutputError(message, output string) *protocol.PanelError {
	output = strings.TrimSpace(output)
	if len(output) > archiveOutputCap {
		output = output[:archiveOutputCap] + "…"
	}
	return &protocol.PanelError{
		Code:    protocol.CodeBadRequest,
		Message: message,
		Details: map[string]any{"output": output},
	}
}

// writeArchiveZip writes a zip archive in pure Go, so no external zip binary is
// required and symlinks are stored without leaking file content.
func writeArchiveZip(tmpName string, sources []archiveSource) (int, error) {
	file, err := os.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	writer := zip.NewWriter(file)
	entries := 0
	var total int64
	fail := func(err error) (int, error) {
		_ = writer.Close()
		_ = file.Close()
		return 0, err
	}
	for _, src := range sources {
		walkErr := filepath.WalkDir(src.host, func(host string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				return infoErr
			}
			name := src.rel
			if src.virtual == "/" {
				name = ""
			}
			if host != src.host {
				sub, relErr := filepath.Rel(src.host, host)
				if relErr != nil {
					return relErr
				}
				subSlash := filepath.ToSlash(sub)
				if name == "" {
					name = subSlash
				} else {
					name += "/" + subSlash
				}
			} else if src.virtual == "/" {
				return nil // do not archive the root directory itself
			}
			if name == "" {
				return nil
			}
			if entry.IsDir() {
				header := &zip.FileHeader{Name: name + "/", Method: zip.Store}
				header.SetMode(info.Mode())
				if _, err := writer.CreateHeader(header); err != nil {
					return err
				}
				entries++
			} else if info.Mode()&os.ModeSymlink != 0 {
				target, readErr := os.Readlink(host)
				if readErr != nil {
					return readErr
				}
				header := &zip.FileHeader{Name: name, Method: zip.Store}
				header.SetMode(os.ModeSymlink | 0o777)
				part, err := writer.CreateHeader(header)
				if err != nil {
					return err
				}
				if _, err := part.Write([]byte(target)); err != nil {
					return err
				}
				entries++
			} else if info.Mode().IsRegular() {
				header, err := zip.FileInfoHeader(info)
				if err != nil {
					return err
				}
				header.Name = name
				header.Method = zip.Deflate
				part, err := writer.CreateHeader(header)
				if err != nil {
					return err
				}
				in, err := os.Open(host)
				if err != nil {
					return err
				}
				written, copyErr := io.Copy(part, in)
				_ = in.Close()
				if copyErr != nil {
					return copyErr
				}
				total += written
				entries++
			} else {
				return nil // skip devices and other special files
			}
			if entries > maxArchiveEntries {
				return protocol.BadRequest("归档条目超过 10 万上限")
			}
			if total > maxArchiveBytes {
				return protocol.BadRequest("归档内容超过 5 GiB 上限")
			}
			return nil
		})
		if walkErr != nil {
			return fail(walkErr)
		}
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		return 0, err
	}
	if err := file.Close(); err != nil {
		return 0, err
	}
	return entries, nil
}

// handleExtract implements POST /api/v1/files/extract.
func (m *Module) handleExtract(w http.ResponseWriter, r *http.Request) {
	var req extractRequest
	if !decodeBody(w, r, &req, defaultJSONBytes) {
		return
	}
	if strings.TrimSpace(req.Root) == "" || req.Path == "" || strings.TrimSpace(req.Destination) == "" {
		httpapi.Fail(w, protocol.BadRequest("root、path、destination 不能为空"))
		return
	}
	src, err := m.sb.resolve(req.Root, req.Path)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !src.exists || src.brokenLink {
		httpapi.Fail(w, protocol.NotFound("归档文件", src.virtual))
		return
	}
	info, err := os.Stat(src.host)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, src.virtual))
		return
	}
	if !info.Mode().IsRegular() {
		httpapi.Fail(w, protocol.BadRequest("只能解压普通文件"))
		return
	}
	dest, err := m.sb.resolve(req.Root, req.Destination)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if dest.exists {
		if !isDirTarget(dest) {
			httpapi.Fail(w, protocol.Conflict("解压目标已存在且不是目录"))
			return
		}
	} else if err := os.MkdirAll(dest.target, 0o755); err != nil {
		httpapi.Fail(w, mapFSError(err, dest.virtual))
		return
	}

	format, err := detectArchiveFormat(src.host, src.virtual, req.Format)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	var entries int
	switch format {
	case "zip":
		entries, err = extractZipArchive(src.host, dest.target)
	case "tar", "tar.gz":
		entries, err = extractTarArchive(src.host, format == "tar.gz", dest.target)
	default:
		err = protocol.BadRequest("无法识别的归档格式")
	}
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, FileExtractResult{Destination: dest.virtual, Entries: entries})
}

func detectArchiveFormat(host, virtual, explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		return normalizeArchiveFormat(explicit)
	}
	lower := strings.ToLower(virtual)
	switch {
	case strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz"):
		return "tar.gz", nil
	case strings.HasSuffix(lower, ".tar"):
		return "tar", nil
	case strings.HasSuffix(lower, ".zip"):
		return "zip", nil
	}
	file, err := os.Open(host)
	if err != nil {
		return "", mapFSError(err, virtual)
	}
	defer file.Close()
	magic := make([]byte, 4)
	n, _ := io.ReadFull(file, magic)
	magic = magic[:n]
	switch {
	case len(magic) >= 2 && magic[0] == 0x1f && magic[1] == 0x8b:
		return "tar.gz", nil
	case len(magic) >= 4 && magic[0] == 'P' && magic[1] == 'K':
		return "zip", nil
	case len(magic) > 0:
		return "tar", nil
	default:
		return "", protocol.BadRequest("无法识别归档格式")
	}
}

type archiveEntry struct {
	name   string
	target string
	isDir  bool
	mode   os.FileMode
}

type tarStream struct {
	reader io.Reader
	file   *os.File
	gzip   *gzip.Reader
}

func (s *tarStream) Close() error {
	if s.gzip != nil {
		_ = s.gzip.Close()
	}
	return s.file.Close()
}

func openTarStream(host string, compressed bool) (*tarStream, error) {
	file, err := os.Open(host)
	if err != nil {
		return nil, err
	}
	stream := &tarStream{file: file}
	if !compressed {
		stream.reader = file
		return stream, nil
	}
	gz, err := gzip.NewReader(file)
	if err != nil {
		_ = file.Close()
		return nil, protocol.BadRequest("gzip 数据无效，无法解压")
	}
	stream.reader = gz
	stream.gzip = gz
	return stream, nil
}

// extractTarArchive performs a validation pass (absolute paths, "..", links,
// conflicts, limits) before writing anything, then a second pass that writes.
func extractTarArchive(host string, compressed bool, dest string) (int, error) {
	stream, err := openTarStream(host, compressed)
	if err != nil {
		if os.IsNotExist(err) || os.IsPermission(err) {
			return 0, mapFSError(err, filepath.Base(host))
		}
		return 0, err
	}
	if _, err := scanTar(stream.reader, dest); err != nil {
		_ = stream.Close()
		return 0, err
	}
	_ = stream.Close()
	stream, err = openTarStream(host, compressed)
	if err != nil {
		return 0, err
	}
	defer stream.Close()
	reader := tar.NewReader(stream.reader)
	var dirs []archiveEntry
	written := int64(0)
	count := 0
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return 0, protocol.BadRequest("tar 归档格式无效")
		}
		switch header.Typeflag {
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			continue
		case tar.TypeSymlink, tar.TypeLink:
			return 0, pathErr("归档包含符号链接或硬链接，已拒绝解压")
		case tar.TypeDir, tar.TypeReg, tar.TypeRegA:
		default:
			return 0, protocol.BadRequest("归档包含不支持的条目类型")
		}
		name, cleanErr := cleanArchiveName(header.Name)
		if cleanErr != nil {
			return 0, cleanErr
		}
		if name == "" {
			continue
		}
		target, targetErr := safeArchiveTarget(dest, name)
		if targetErr != nil {
			return 0, targetErr
		}
		entryMode := os.FileMode(header.Mode).Perm()
		if header.Typeflag == tar.TypeDir || strings.HasSuffix(header.Name, "/") || header.FileInfo().IsDir() {
			if err := os.MkdirAll(target, entryMode|0o700); err != nil {
				return 0, fsWriteError(err)
			}
			dirs = append(dirs, archiveEntry{target: target, mode: entryMode})
			count++
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return 0, fsWriteError(err)
		}
		file, createErr := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, entryMode)
		if createErr != nil {
			return 0, fsWriteError(createErr)
		}
		remaining := maxArchiveBytes - written
		if remaining <= 0 {
			_ = file.Close()
			_ = os.Remove(target)
			return 0, protocol.BadRequest("解压内容超过 5 GiB 上限")
		}
		copied, copyErr := io.Copy(file, io.LimitReader(reader, remaining+1))
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			_ = os.Remove(target)
			if copyErr != nil {
				return 0, copyErr
			}
			return 0, closeErr
		}
		if copied > remaining {
			_ = os.Remove(target)
			return 0, protocol.BadRequest("解压内容超过 5 GiB 上限")
		}
		written += copied
		count++
	}
	for _, dir := range dirs {
		_ = os.Chmod(dir.target, dir.mode|0o700)
	}
	return count, nil
}

func scanTar(reader io.Reader, dest string) ([]archiveEntry, error) {
	tracker := newArchiveTracker(dest)
	tarReader := tar.NewReader(reader)
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, protocol.BadRequest("tar 归档格式无效")
		}
		switch header.Typeflag {
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			continue
		case tar.TypeSymlink, tar.TypeLink:
			return nil, pathErr("归档包含符号链接或硬链接，已拒绝解压")
		case tar.TypeDir, tar.TypeReg, tar.TypeRegA:
		default:
			return nil, protocol.BadRequest("归档包含不支持的条目类型")
		}
		isDir := header.Typeflag == tar.TypeDir || strings.HasSuffix(header.Name, "/") || header.FileInfo().IsDir()
		if _, addErr := tracker.add(header.Name, isDir, header.Size, os.FileMode(header.Mode).Perm()); addErr != nil {
			if errors.Is(addErr, errSkipArchiveEntry) {
				continue
			}
			return nil, addErr
		}
	}
	return tracker.entries, nil
}

// extractZipArchive scans the central directory first (rejecting zip-slip,
// links and conflicts), then extracts.
func extractZipArchive(host, dest string) (int, error) {
	archive, err := zip.OpenReader(host)
	if err != nil {
		return 0, protocol.BadRequest("zip 归档格式无效")
	}
	tracker := newArchiveTracker(dest)
	for _, file := range archive.File {
		if file.Flags&0x1 != 0 {
			_ = archive.Close()
			return 0, protocol.BadRequest("不支持加密的 zip 归档")
		}
		if file.Mode()&os.ModeSymlink != 0 {
			_ = archive.Close()
			return 0, pathErr("归档包含符号链接，已拒绝解压")
		}
		isDir := file.FileInfo().IsDir() || strings.HasSuffix(file.Name, "/")
		if _, addErr := tracker.add(file.Name, isDir, int64(file.UncompressedSize64), file.Mode().Perm()); addErr != nil {
			if errors.Is(addErr, errSkipArchiveEntry) {
				continue
			}
			_ = archive.Close()
			return 0, addErr
		}
	}
	count := 0
	written := int64(0)
	var dirs []archiveEntry
	for _, file := range archive.File {
		if file.Flags&0x1 != 0 || file.Mode()&os.ModeSymlink != 0 {
			_ = archive.Close()
			return 0, pathErr("归档包含加密条目或符号链接，已拒绝解压")
		}
		name, cleanErr := cleanArchiveName(file.Name)
		if cleanErr != nil || name == "" {
			continue
		}
		target, targetErr := safeArchiveTarget(dest, name)
		if targetErr != nil {
			_ = archive.Close()
			return 0, targetErr
		}
		mode := file.Mode().Perm()
		if file.FileInfo().IsDir() || strings.HasSuffix(file.Name, "/") {
			if err := os.MkdirAll(target, mode|0o700); err != nil {
				_ = archive.Close()
				return 0, fsWriteError(err)
			}
			dirs = append(dirs, archiveEntry{target: target, mode: mode})
			count++
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			_ = archive.Close()
			return 0, fsWriteError(err)
		}
		source, openErr := file.Open()
		if openErr != nil {
			_ = archive.Close()
			return 0, protocol.BadRequest("zip 条目不支持加密或压缩方式")
		}
		out, createErr := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if createErr != nil {
			_ = source.Close()
			_ = archive.Close()
			return 0, fsWriteError(createErr)
		}
		remaining := maxArchiveBytes - written
		if remaining <= 0 {
			_ = out.Close()
			_ = source.Close()
			_ = os.Remove(target)
			_ = archive.Close()
			return 0, protocol.BadRequest("解压内容超过 5 GiB 上限")
		}
		copied, copyErr := io.Copy(out, io.LimitReader(source, remaining+1))
		closeErr := out.Close()
		_ = source.Close()
		if copyErr != nil || closeErr != nil {
			_ = os.Remove(target)
			_ = archive.Close()
			if copyErr != nil {
				return 0, copyErr
			}
			return 0, closeErr
		}
		if copied > remaining {
			_ = os.Remove(target)
			_ = archive.Close()
			return 0, protocol.BadRequest("解压内容超过 5 GiB 上限")
		}
		written += copied
		count++
	}
	_ = archive.Close()
	for _, dir := range dirs {
		_ = os.Chmod(dir.target, dir.mode|0o700)
	}
	return count, nil
}

var errSkipArchiveEntry = errors.New("skip archive entry")

type archiveTracker struct {
	dest    string
	seen    map[string]bool // name => isDir
	needed  map[string]bool // names used as a directory prefix
	entries []archiveEntry
	total   int64
}

func newArchiveTracker(dest string) *archiveTracker {
	return &archiveTracker{
		dest:   dest,
		seen:   make(map[string]bool),
		needed: make(map[string]bool),
	}
}

// add validates one archive entry and registers it. It rejects duplicate
// files, file/directory collisions and pre-existing files (CONFLICT).
func (t *archiveTracker) add(raw string, isDir bool, size int64, mode os.FileMode) (string, error) {
	name, err := cleanArchiveName(raw)
	if err != nil {
		return "", err
	}
	if name == "" {
		return "", errSkipArchiveEntry
	}
	if existing, ok := t.seen[name]; ok {
		if existing && isDir {
			return "", errSkipArchiveEntry
		}
		return "", protocol.BadRequest("归档包含重复条目")
	}
	parts := strings.Split(name, "/")
	for i := 1; i < len(parts); i++ {
		parent := strings.Join(parts[:i], "/")
		if existing, ok := t.seen[parent]; ok && !existing {
			return "", protocol.BadRequest("归档包含文件与目录同名的冲突条目")
		}
		t.needed[parent] = true
	}
	if !isDir && t.needed[name] {
		return "", protocol.BadRequest("归档包含文件与目录同名的冲突条目")
	}
	target, err := safeArchiveTarget(t.dest, name)
	if err != nil {
		return "", err
	}
	if isDir {
		if info, statErr := os.Lstat(target); statErr == nil && !info.IsDir() {
			return "", protocol.Conflict("解压目标已存在同名文件")
		}
	} else if _, statErr := os.Lstat(target); statErr == nil {
		return "", protocol.Conflict("解压目标已存在同名文件")
	}
	t.seen[name] = isDir
	t.total += size
	if len(t.seen) > maxArchiveEntries {
		return "", protocol.BadRequest("归档条目超过 10 万上限")
	}
	if t.total > maxArchiveBytes {
		return "", protocol.BadRequest("解压内容超过 5 GiB 上限")
	}
	t.entries = append(t.entries, archiveEntry{name: name, target: target, isDir: isDir, mode: mode})
	return target, nil
}

// cleanArchiveName normalizes an archive member to a relative slash path and
// rejects absolute paths, "..", backslashes, drive letters and reserved names.
func cleanArchiveName(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "\\") || filepath.IsAbs(raw) {
		return "", pathErr("归档包含绝对路径条目")
	}
	virtual, err := normalizeVirtual(raw)
	if err != nil {
		return "", err
	}
	if virtual == "/" {
		return "", nil
	}
	return strings.TrimPrefix(virtual, "/"), nil
}

func safeArchiveTarget(dest, rel string) (string, error) {
	target := filepath.Join(dest, filepath.FromSlash(rel))
	if !within(dest, target) || samePath(dest, target) {
		return "", pathErr("归档条目越界（zip-slip）")
	}
	return target, nil
}

func fsWriteError(err error) error {
	if os.IsExist(err) {
		return protocol.Conflict("解压目标已存在同名文件")
	}
	if os.IsPermission(err) {
		return forbiddenErr()
	}
	return err
}

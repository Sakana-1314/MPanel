package files

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/sakana-1314/mpanel/core/httpapi"
	"github.com/sakana-1314/mpanel/core/protocol"
)

const maxSearchVisited = 200_000

// handleSearch implements GET /api/v1/files/search (name glob or content).
func (m *Module) handleSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	rootName := strings.TrimSpace(query.Get("root"))
	if rootName == "" {
		httpapi.Fail(w, protocol.BadRequest("参数 root 不能为空"))
		return
	}
	needle := query.Get("q")
	if strings.TrimSpace(needle) == "" {
		httpapi.Fail(w, protocol.BadRequest("参数 q 不能为空"))
		return
	}
	mode := strings.ToLower(strings.TrimSpace(query.Get("mode")))
	if mode == "" {
		mode = "name"
	}
	if mode != "name" && mode != "content" {
		httpapi.Fail(w, protocol.BadRequest("mode 只支持 name 或 content"))
		return
	}
	caseSensitive, _, err := boolQuery(r, "caseSensitive")
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	includeHidden, _, err := boolQuery(r, "includeHidden")
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	limit, err := pageLimit(r, defaultSearchLimit, maxSearchLimit)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	glob := mode == "name" && strings.ContainsAny(needle, "*?[")
	if glob {
		if _, matchErr := filepath.Match(needle, ""); matchErr != nil {
			httpapi.Fail(w, protocol.BadRequest("q 不是合法的 glob 表达式"))
			return
		}
	}

	virtual := query.Get("path")
	if virtual == "" {
		virtual = "/"
	}
	res, err := m.sb.resolve(rootName, virtual)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if !res.exists || res.brokenLink {
		httpapi.Fail(w, protocol.NotFound("搜索路径", res.virtual))
		return
	}
	baseHost := res.target
	baseInfo, err := os.Stat(baseHost)
	if err != nil {
		httpapi.Fail(w, mapFSError(err, res.virtual))
		return
	}

	matches := make([]FileItem, 0, limit+1)
	truncated := false
	visited := 0
	walkErr := filepath.WalkDir(baseHost, func(host string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if host == baseHost {
				return walkErr
			}
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		visited++
		if visited > maxSearchVisited {
			truncated = true
			return filepath.SkipAll
		}
		name := entry.Name()
		hidden := strings.HasPrefix(name, ".")
		if hidden && !includeHidden && host != baseHost {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		isDir := entry.IsDir()
		if host == baseHost && isDir {
			return nil // do not return the search root itself
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		if mode == "name" {
			if !matchName(needle, name, caseSensitive, glob) {
				return nil
			}
		} else {
			if isDir || !info.Mode().IsRegular() {
				return nil
			}
			if info.Size() > maxSearchFileBytes {
				return nil
			}
			content, readErr := os.ReadFile(host)
			if readErr != nil || isBinaryData(content) {
				return nil
			}
			if !containsQuery(content, needle, caseSensitive) {
				return nil
			}
		}
		itemVirtual, pathErr := virtualPathFromHost(res.rootReal, host)
		if pathErr != nil {
			return nil
		}
		matches = append(matches, itemFromInfo(res.rootReal, rootName, itemVirtual, host, info))
		if len(matches) > limit {
			truncated = true
			return filepath.SkipAll
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, filepath.SkipAll) {
		if baseInfo.IsDir() {
			httpapi.Fail(w, mapFSError(walkErr, res.virtual))
			return
		}
	}
	if len(matches) > limit {
		matches = matches[:limit]
	}
	total := len(matches)
	httpapi.OK(w, FileSearchResult{
		Available: true,
		Items:     matches,
		Total:     &total,
		Query:     needle,
		Truncated: truncated,
	})
}

func matchName(pattern, name string, caseSensitive, glob bool) bool {
	haystack, needle := name, pattern
	if !caseSensitive {
		haystack = strings.ToLower(haystack)
		needle = strings.ToLower(needle)
	}
	if glob {
		matched, err := filepath.Match(needle, haystack)
		return err == nil && matched
	}
	return strings.Contains(haystack, needle)
}

func containsQuery(content []byte, needle string, caseSensitive bool) bool {
	haystack := string(content)
	if caseSensitive {
		return strings.Contains(haystack, needle)
	}
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}

// virtualPathFromHost maps an absolute host path back to the root-relative
// virtual path returned by the API.
func virtualPathFromHost(rootReal, host string) (string, error) {
	rel, err := filepath.Rel(rootReal, host)
	if err != nil || filepath.IsAbs(rel) {
		return "", pathErr("路径越界")
	}
	if rel == "." {
		return "/", nil
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", pathErr("路径越界")
	}
	return "/" + filepath.ToSlash(rel), nil
}

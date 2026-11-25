package files

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sakana-1314/mpanel/internal/config"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

func panelCode(t *testing.T, err error) protocol.ErrorCode {
	t.Helper()
	var panelErr *protocol.PanelError
	if !errors.As(err, &panelErr) {
		t.Fatalf("期望 PanelError，实际 %v", err)
	}
	return panelErr.Code
}

func TestNormalizeVirtualRejectsEscapes(t *testing.T) {
	valid := map[string]string{
		"":             "/",
		"/":            "/",
		"a/b":          "/a/b",
		"/a/b/":        "/a/b",
		"./a/./b":      "/a/b",
		"a//b":         "/a/b",
		"/dir/file.md": "/dir/file.md",
	}
	for input, want := range valid {
		got, err := normalizeVirtual(input)
		if err != nil {
			t.Fatalf("normalizeVirtual(%q) 失败: %v", input, err)
		}
		if got != want {
			t.Fatalf("normalizeVirtual(%q) = %q，期望 %q", input, got, want)
		}
	}

	invalid := []string{
		"..",
		"../etc/passwd",
		"a/../../b",
		"/a/../b",
		"C:/Windows",
		"C:\\Windows",
		`\\server\share`,
		"//server/share",
		`dir\file.txt`,
		"CON",
		"con.txt",
		"a/NUL/b",
		"com1",
		"LPT9.log",
		"a\x00b",
		"a\nb",
		"a\x7fb",
	}
	for _, input := range invalid {
		if _, err := normalizeVirtual(input); err == nil {
			t.Fatalf("normalizeVirtual(%q) 应被拒绝", input)
		}
	}
}

func TestSandboxRootResolution(t *testing.T) {
	base := t.TempDir()
	rootDir := filepath.Join(base, "root")
	outsideDir := filepath.Join(base, "outside")
	for _, dir := range []string{rootDir, outsideDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(rootDir, "hello.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outsideDir, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	sb := newSandbox([]config.Root{
		{Name: "files", Path: rootDir},
		{Name: "bad name", Path: rootDir}, // invalid name is skipped
		{Name: "missing", Path: filepath.Join(base, "nope")},
	})
	if _, ok := sb.byName["bad name"]; ok {
		t.Fatal("非法 root 名不应注册")
	}

	res, err := sb.resolve("files", "/hello.txt")
	if err != nil {
		t.Fatalf("解析合法路径失败: %v", err)
	}
	if !res.exists || res.virtual != "/hello.txt" {
		t.Fatalf("解析结果不正确: %+v", res)
	}
	if !within(res.rootReal, res.target) {
		t.Fatalf("目标 %q 不在根 %q 内", res.target, res.rootReal)
	}

	// A leading slash is a virtual root marker, not a host absolute path.
	leading, err := sb.resolve("files", "/etc/passwd")
	if err != nil {
		t.Fatalf("前导斜杠应被当作根内虚拟路径: %v", err)
	}
	if leading.host != filepath.Join(res.rootReal, "etc", "passwd") {
		t.Fatalf("前导斜杠解析到了根外: %q", leading.host)
	}
	if !within(leading.rootReal, leading.target) {
		t.Fatalf("前导斜杠目标越界: %q", leading.target)
	}

	// A host absolute path must never be used as-is. On Windows it contains
	// backslashes and is rejected; elsewhere it is re-rooted under the sandbox.
	hostAbsolute := filepath.Join(rootDir, "hello.txt")
	absoluteRes, absoluteErr := sb.resolve("files", hostAbsolute)
	if runtime.GOOS == "windows" {
		if absoluteErr == nil {
			t.Fatalf("Windows 宿主绝对路径应被拒绝")
		}
	} else {
		if absoluteErr != nil {
			t.Fatalf("宿主绝对路径应按虚拟路径重新定位: %v", absoluteErr)
		}
		if !within(absoluteRes.rootReal, absoluteRes.target) {
			t.Fatalf("宿主绝对路径逃逸: %q", absoluteRes.target)
		}
		if samePath(absoluteRes.target, hostAbsolute) {
			t.Fatalf("宿主绝对路径被直接使用: %q", absoluteRes.target)
		}
	}

	if _, err := sb.resolve("unknown", "/"); panelCode(t, err) != protocol.CodeNotFound {
		t.Fatalf("未知 root 应返回 NOT_FOUND，实际 %v", err)
	}
	if _, err := sb.resolve("missing", "/"); panelCode(t, err) != protocol.CodeUnavailable {
		t.Fatalf("缺失 root 应返回 UNAVAILABLE，实际 %v", err)
	}
	if _, err := sb.resolve("files", "../outside/secret.txt"); panelCode(t, err) != protocol.CodeBadRequest {
		t.Fatalf(".. 越界应返回 BAD_REQUEST，实际 %v", err)
	}
	if _, err := sb.resolve("files", "C:/Windows/system32"); panelCode(t, err) != protocol.CodeBadRequest {
		t.Fatalf("盘符路径应返回 BAD_REQUEST，实际 %v", err)
	}
	if _, err := sb.resolve("files", "CON"); panelCode(t, err) != protocol.CodeBadRequest {
		t.Fatalf("Windows 保留名应返回 BAD_REQUEST，实际 %v", err)
	}
	if _, err := sb.resolve("files", `\\server\share`); panelCode(t, err) != protocol.CodeBadRequest {
		t.Fatalf("UNC 路径应返回 BAD_REQUEST，实际 %v", err)
	}

	// Symlink escaping the root must be rejected, including through a missing
	// child (resolveMissing checks the deepest existing ancestor).
	escapeLink := filepath.Join(rootDir, "escape")
	if err := os.Symlink(outsideDir, escapeLink); err == nil {
		if _, err := sb.resolve("files", "/escape"); panelCode(t, err) != protocol.CodeBadRequest {
			t.Fatalf("符号链接越界应返回 BAD_REQUEST，实际 %v", err)
		}
		if _, err := sb.resolve("files", "/escape/secret.txt"); panelCode(t, err) != protocol.CodeBadRequest {
			t.Fatalf("经符号链接越界应返回 BAD_REQUEST，实际 %v", err)
		}
		_ = os.Remove(escapeLink)
	} else {
		t.Logf("跳过符号链接越界测试（当前平台无法创建符号链接）: %v", err)
	}

	// A symlink that stays inside the root is allowed for reads.
	insideLink := filepath.Join(rootDir, "inside.txt")
	if err := os.Symlink(filepath.Join(rootDir, "hello.txt"), insideLink); err == nil {
		linked, err := sb.resolve("files", "/inside.txt")
		if err != nil {
			t.Fatalf("根内符号链接应被允许: %v", err)
		}
		if filepath.Base(linked.target) != "hello.txt" {
			t.Fatalf("链接目标解析不正确: %q", linked.target)
		}
		_ = os.Remove(insideLink)
	}
}

func TestSandboxMissingRootUnavailableList(t *testing.T) {
	base := t.TempDir()
	sb := newSandbox([]config.Root{{Name: "files", Path: filepath.Join(base, "gone")}})
	available, reason := sb.availability()
	if available || reason == "" {
		t.Fatalf("缺失根应不可用并带原因，实际 available=%v reason=%q", available, reason)
	}
}

func TestWithin(t *testing.T) {
	base := t.TempDir()
	child := filepath.Join(base, "a", "b")
	if !within(base, child) {
		t.Fatal("子路径应在根内")
	}
	if !within(base, base) {
		t.Fatal("根自身应在根内")
	}
	if within(base, filepath.Dir(base)) {
		t.Fatal("父路径不应在根内")
	}
	if runtime.GOOS == "windows" {
		if !within(base, filepath.Join(base, "A", "b")) {
			t.Log("Windows 大小写路径比较由 filepath.Rel 决定，跳过大小写断言")
		}
	}
}

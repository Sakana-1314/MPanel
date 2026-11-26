package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentLayoutUses1PanelPaths(t *testing.T) {
	base := t.TempDir()
	cfg := NewAgent(base)
	if err := cfg.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	if got := cfg.AppsDir(); got != filepath.Join(base, "data", "apps") {
		t.Fatalf("AppsDir = %q", got)
	}
	if got := cfg.SitesDir(); got != filepath.Join(base, "data", "sites") {
		t.Fatalf("SitesDir = %q", got)
	}
	if got := cfg.ComposeDir(); got != filepath.Join(base, "data", "compose") {
		t.Fatalf("ComposeDir = %q", got)
	}
	if got := cfg.BackupRoot(); got != filepath.Join(base, "backup") {
		t.Fatalf("BackupRoot = %q", got)
	}
	if got := cfg.RuntimeDir(); got != filepath.Join(base, "runtime") {
		t.Fatalf("RuntimeDir = %q", got)
	}
	confDir, dataDir := cfg.CaddyDirs()
	if confDir != filepath.Join(base, "data", "apps", "caddy") {
		t.Fatalf("CaddyDirs conf = %q", confDir)
	}
	if dataDir != filepath.Join(confDir, "data") {
		t.Fatalf("CaddyDirs data = %q", dataDir)
	}
	for _, dir := range []string{
		filepath.Join(base, "data", "sites"),
		filepath.Join(base, "data", "compose"),
		filepath.Join(base, "data", "apps"),
		filepath.Join(base, "backup", "caddy"),
		filepath.Join(base, "backup", "databases"),
		filepath.Join(base, "runtime"),
		filepath.Join(base, "web"),
	} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Fatalf("目录未创建 %s: %v", dir, err)
		}
	}
}

func TestAgentLayoutKeepsLegacyDirs(t *testing.T) {
	base := t.TempDir()
	cfg := NewAgent(base)
	for _, dir := range []string{
		filepath.Join(cfg.Agent.DataDir, "caddy"),
		filepath.Join(cfg.Agent.DataDir, "sites"),
		filepath.Join(cfg.Agent.DataDir, "stacks"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if confDir, _ := cfg.CaddyDirs(); confDir != filepath.Join(cfg.Agent.DataDir, "caddy") {
		t.Fatalf("旧 Caddy 目录未兼容: %q", confDir)
	}
	if got := cfg.SitesDir(); got != filepath.Join(cfg.Agent.DataDir, "sites") {
		t.Fatalf("旧站点根未兼容: %q", got)
	}
	if got := cfg.ComposeDir(); got != filepath.Join(cfg.Agent.DataDir, "stacks") {
		t.Fatalf("旧编排目录未兼容: %q", got)
	}
}

func TestLoadUsesBinaryVersion(t *testing.T) {
	base := t.TempDir()

	app := NewApp(base)
	app.System.Version = "stale"
	if err := SaveApp(app); err != nil {
		t.Fatal(err)
	}
	loadedApp, err := LoadApp(base)
	if err != nil {
		t.Fatal(err)
	}
	if loadedApp.System.Version != Version {
		t.Fatalf("core 版本 = %q，期望 %q", loadedApp.System.Version, Version)
	}

	agent := NewAgent(base)
	agent.Agent.Version = "stale"
	if err := SaveAgent(agent); err != nil {
		t.Fatal(err)
	}
	loadedAgent, err := LoadAgent(base)
	if err != nil {
		t.Fatal(err)
	}
	if loadedAgent.Agent.Version != Version {
		t.Fatalf("agent 版本 = %q，期望 %q", loadedAgent.Agent.Version, Version)
	}
}

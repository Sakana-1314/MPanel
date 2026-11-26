package main

import (
	"os"
	"testing"

	"github.com/sakana-1314/mpanel/server/core/config"
)

func TestLoadExistingCoreConfigDoesNotCreateFile(t *testing.T) {
	baseDir := t.TempDir()
	if _, err := loadExistingCoreConfig(baseDir); err == nil {
		t.Fatal("期望在配置缺失时返回错误")
	}
	if _, err := os.Stat(config.CorePath(baseDir)); !os.IsNotExist(err) {
		t.Fatalf("只读命令不应创建 app.yaml，stat err = %v", err)
	}
}

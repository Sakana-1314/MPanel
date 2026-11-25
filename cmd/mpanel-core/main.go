// mpanel-core is the MPanel control plane.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/sakana-1314/mpanel/core"
	"github.com/sakana-1314/mpanel/internal/auth"
	"github.com/sakana-1314/mpanel/internal/config"
)

func main() {
	command := "serve"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}

	baseDir := envOr("MPANEL_BASE_DIR", "")
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--base-dir":
			if i+1 < len(args) {
				baseDir = args[i+1]
				i++
			}
		case "--port":
			if i+1 < len(args) {
				os.Setenv("MPANEL_PORT", args[i+1])
				i++
			}
		case "--bind":
			if i+1 < len(args) {
				os.Setenv("MPANEL_BIND_ADDRESS", args[i+1])
				i++
			}
		case "--web-dir":
			if i+1 < len(args) {
				os.Setenv("MPANEL_WEB_DIR", args[i+1])
				i++
			}
		}
	}
	if baseDir == "" {
		baseDir = config.DefaultBaseDir()
	}

	switch command {
	case "serve":
		if err := serve(baseDir); err != nil {
			fmt.Fprintln(os.Stderr, "mpanel-core:", err)
			os.Exit(1)
		}
	case "version", "--version", "-v":
		fmt.Println("mpanel-core " + config.Version)
	case "reset-password":
		if err := resetPassword(baseDir); err != nil {
			fmt.Fprintln(os.Stderr, "mpanel-core:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintf(os.Stderr, "未知命令 %q\n用法: mpanel-core [serve|version|reset-password] [--base-dir DIR] [--port PORT] [--bind ADDR] [--web-dir DIR]\n", command)
		os.Exit(2)
	}
}

func serve(baseDir string) error {
	cfg, err := config.LoadApp(baseDir)
	if err != nil {
		return err
	}
	logger := newLogger(cfg.Log.Level)
	app, err := core.New(cfg, logger)
	if err != nil {
		return err
	}
	defer app.Close()

	if !app.Auth().Configured() {
		token, _, err := app.Auth().EnsureBootstrap()
		if err == nil {
			logger.Warn("面板尚未初始化：请使用下面的 bootstrap token 调用 POST /api/v1/auth/setup", "bootstrapToken", token)
		}
	}

	addr := cfg.System.BindAddress + ":" + strconv.Itoa(cfg.System.Port)
	server := &http.Server{
		Addr:              addr,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 20 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		logger.Info("MPanel core 已启动", "listen", addr, "baseDir", cfg.System.BaseDir, "conf", config.CorePath(cfg.System.BaseDir), "data", cfg.System.DataDir)
		errCh <- server.ListenAndServe()
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-ctx.Done():
		logger.Info("收到退出信号，正在关闭")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func resetPassword(baseDir string) error {
	cfg, err := config.LoadApp(baseDir)
	if err != nil {
		return err
	}
	svc, err := auth.New(cfg, newLogger(cfg.Log.Level))
	if err != nil {
		return err
	}
	token, path, err := svc.ResetPassword()
	if err != nil {
		return err
	}
	fmt.Printf("已清除面板密码。\nbootstrap token 已写入 %s：\n%s\n请使用 POST /api/v1/auth/setup 重新初始化。\n", path, token)
	return nil
}

func newLogger(level string) *slog.Logger {
	var parsed slog.Level
	switch strings.ToLower(level) {
	case "debug":
		parsed = slog.LevelDebug
	case "warn":
		parsed = slog.LevelWarn
	case "error":
		parsed = slog.LevelError
	default:
		parsed = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parsed}))
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

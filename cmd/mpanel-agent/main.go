// mpanel-agent is the MPanel feature agent (sites, databases, containers,
// files, terminal, tasks, system).
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/agent/modules"
	"github.com/sakana-1314/mpanel/internal/config"
)

func main() {
	command := "serve"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}

	baseDir := envOr("MPANEL_AGENT_BASE_DIR", envOr("MPANEL_BASE_DIR", ""))
	for i := 0; i < len(args); i++ {
		value := func() string {
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch args[i] {
		case "--base-dir":
			baseDir = value()
		case "--transport":
			os.Setenv("MPANEL_AGENT_TRANSPORT", value())
		case "--listen":
			os.Setenv("MPANEL_AGENT_LISTEN", value())
		case "--core-url":
			os.Setenv("MPANEL_CORE_URL", value())
		case "--edge-key":
			os.Setenv("MPANEL_EDGE_KEY", value())
		}
	}
	if baseDir == "" {
		baseDir = config.DefaultBaseDir()
	}

	switch command {
	case "serve":
		if err := serve(baseDir); err != nil {
			fmt.Fprintln(os.Stderr, "mpanel-agent:", err)
			os.Exit(1)
		}
	case "doctor":
		doctor(baseDir)
	case "version", "--version", "-v":
		fmt.Println("mpanel-agent " + config.Version)
	default:
		fmt.Fprintf(os.Stderr, "未知命令 %q\n用法: mpanel-agent [serve|doctor|version] [--base-dir DIR] [--transport http|stdio|reverse-ws] [--listen ADDR] [--core-url URL] [--edge-key KEY]\n", command)
		os.Exit(2)
	}
}

func serve(baseDir string) error {
	cfg, err := config.LoadAgent(baseDir)
	if err != nil {
		return err
	}
	logger := newLogger(cfg.Log.Level)
	app, err := agent.New(cfg, logger, modules.All()...)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("MPanel agent 启动", "transport", cfg.Agent.Transport, "baseDir", cfg.Agent.BaseDir, "conf", config.AgentPath(cfg.Agent.BaseDir))
	return app.Run(ctx)
}

func doctor(baseDir string) {
	cfg, err := config.LoadAgent(baseDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "读取配置失败:", err)
		os.Exit(1)
	}
	app, err := agent.New(cfg, newLogger("warn"), modules.All()...)
	if err != nil {
		fmt.Fprintln(os.Stderr, "初始化失败:", err)
		os.Exit(1)
	}
	caps := app.Prober().Get(true)
	show := func(label string, available bool, version, reason string) {
		state := "不可用"
		if available {
			state = "可用"
		}
		detail := version
		if detail == "" {
			detail = reason
		}
		fmt.Printf("  %-10s %-6s %s\n", label, state, detail)
	}
	fmt.Println("MPanel agent 诊断")
	fmt.Printf("  %-10s %s\n", "配置", config.AgentPath(cfg.Agent.BaseDir))
	fmt.Printf("  %-10s %s\n", "数据目录", cfg.Agent.DataDir)
	fmt.Printf("  %-10s %s\n", "传输", cfg.Agent.Transport)
	fmt.Printf("  %-10s %s\n", "监听", cfg.Agent.Listen)
	fmt.Printf("  %-10s %s\n", "core", cfg.Agent.CoreURL)
	fmt.Printf("  %-10s %s\n", "入网密钥", presence(cfg.Agent.EdgeKey))
	fmt.Printf("  %-10s %s\n", "机器 secret", presence(cfg.Agent.MachineSecret))
	fmt.Printf("  %-10s %s\n", "本地 token", presence(cfg.Agent.Token))
	fmt.Println("  能力探测：")
	show("caddy", caps.Caddy.Available, caps.Caddy.Version, caps.Caddy.Reason)
	show("docker", caps.Docker.Available, caps.Docker.Version, caps.Docker.Reason)
	show("postgres", caps.Postgres.Available, caps.Postgres.Version, caps.Postgres.Reason)
	show("redis", caps.Redis.Available, caps.Redis.Version, caps.Redis.Reason)
	show("pty", caps.PTY.Available, caps.PTY.Version, caps.PTY.Reason)
}

func presence(value string) string {
	if value == "" {
		return "未设置"
	}
	return "已设置"
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

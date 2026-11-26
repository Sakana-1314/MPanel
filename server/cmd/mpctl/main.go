// mpctl manages the MPanel systemd services, mirroring 1Panel's 1pctl.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"github.com/sakana-1314/mpanel/server/core/config"
)

var services = map[string]string{
	"core":  "mpanel-core.service",
	"agent": "mpanel-agent.service",
}

func main() {
	args := os.Args[1:]
	command := "help"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	target := "all"
	if len(args) > 0 && (args[0] == "core" || args[0] == "agent" || args[0] == "all") {
		target = args[0]
	}
	baseDir := config.DefaultBaseDir()

	switch command {
	case "status", "start", "stop", "restart":
		if !systemdAvailable() {
			fmt.Println("当前环境没有 systemd（Windows/容器内），请直接前台运行：mpanel-core / mpanel-agent。")
			os.Exit(1)
		}
		runServiceCommand(command, target, baseDir)
	case "version":
		fmt.Println("mpctl " + config.Version)
	case "listen-ip":
		cfg, err := loadExistingCoreConfig(baseDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		bind := cfg.System.BindAddress
		if bind == "0.0.0.0" {
			bind = "<本机所有地址>"
		}
		fmt.Printf("core 监听：%s:%d\nconf：%s\n", bind, cfg.System.Port, config.CorePath(baseDir))
	case "user-info":
		cfg, err := loadExistingCoreConfig(baseDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		username := cfg.System.Username
		if username == "" {
			username = "admin"
		}
		state := "未设置（请使用 bootstrap token 初始化）"
		if cfg.System.Password != "" {
			state = "已设置"
		}
		fmt.Printf("用户名：%s\n密码：%s\n配置文件：%s\n", username, state, config.CorePath(baseDir))
	case "reset":
		resetPassword(baseDir)
	case "uninstall":
		fmt.Println("卸载步骤：")
		fmt.Println("  1. systemctl disable --now mpanel-core.service mpanel-agent.service")
		fmt.Println("  2. rm -f /etc/systemd/system/mpanel-core.service /etc/systemd/system/mpanel-agent.service")
		fmt.Println("  3. rm -f /usr/local/bin/mpanel-core /usr/local/bin/mpanel-agent /usr/local/bin/mpctl /usr/bin/mpctl /usr/bin/mpanel")
		fmt.Printf("  4. 如需彻底删除数据：rm -rf %s\n", baseDir)
	case "help", "-h", "--help":
		printHelp()
	default:
		printHelp()
		os.Exit(2)
	}
}

func printHelp() {
	name := "mpctl"
	fmt.Printf(`%s — MPanel 服务管理（对应 1Panel 的 1pctl）

用法：
  %s status  [core|agent|all]     查看服务状态
  %s start   [core|agent|all]     启动服务
  %s stop    [core|agent|all]     停止服务
  %s restart [core|agent|all]     重启服务
  %s version                      查看版本
  %s listen-ip                    查看监听地址
  %s user-info                    查看面板账号
  %s reset                        重置面板密码（生成 bootstrap token）
  %s uninstall                    显示卸载步骤

服务单元：mpanel-core.service / mpanel-agent.service
默认安装根：/opt/mpanel（1Panel 布局：conf/ data/ db/ log/ backup/ tmp/ runtime/ web/）
`, name, name, name, name, name, name, name, name, name, name)
}

func runServiceCommand(command, target, baseDir string) {
	names := []string{}
	switch target {
	case "all":
		names = []string{services["core"], services["agent"]}
	default:
		names = []string{services[target]}
	}
	for _, service := range names {
		output, err := exec.Command("systemctl", command, service).CombinedOutput()
		if err != nil {
			fmt.Printf("❌ %s %s 失败：%s\n", service, command, strings.TrimSpace(string(output)))
			continue
		}
		fmt.Printf("✅ %s %s 成功\n", service, command)
	}
	if command == "status" && target != "agent" {
		// Read-only: never create app.yaml (an agent-only host has no core).
		if cfg, err := loadExistingCoreConfig(baseDir); err == nil {
			fmt.Printf("面板地址：http://<本机 IP>:%s\n", strconv.Itoa(cfg.System.Port))
		}
	}
}

// loadExistingCoreConfig never creates a default config as a side effect of a
// read-only command (especially on agent-only machines).
func loadExistingCoreConfig(baseDir string) (*config.App, error) {
	path := config.CorePath(baseDir)
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("面板尚未初始化：%s", path)
	}
	cfg, err := config.LoadApp(baseDir)
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}
	return cfg, nil
}

// resetPassword delegates to `mpanel-core reset-password` so the CLI matches
// 1Panel's `1pctl reset` workflow.
func resetPassword(baseDir string) {
	bin, err := exec.LookPath("mpanel-core")
	if err != nil {
		fmt.Fprintln(os.Stderr, "未找到 mpanel-core，请确认已安装到 PATH。")
		os.Exit(1)
	}
	cmd := exec.Command(bin, "reset-password", "--base-dir", baseDir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "重置密码失败:", err)
		os.Exit(1)
	}
}

func systemdAvailable() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false
	}
	return true
}

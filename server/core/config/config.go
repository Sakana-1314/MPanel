// Package config loads MPanel configuration using the same directory contract
// as 1Panel:
//
//	/opt/mpanel/conf/app.yaml    core configuration
//	/opt/mpanel/conf/agent.yaml  agent configuration
//	/opt/mpanel/data             data root
//	/opt/mpanel/log              logs
//	/opt/mpanel/db/core.db       core state database
//	/opt/mpanel/backup           backups
//
// Every field can be overridden with an MPANEL_* environment variable so that
// containers and CI do not need to write into /opt.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefaultBaseDir mirrors 1Panel's /opt/1panel. On non-Linux hosts (development)
// it falls back to ~/.mpanel so an unprivileged process can still start.
func DefaultBaseDir() string {
	if runtime.GOOS == "linux" {
		return "/opt/mpanel"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".mpanel"
	}
	return filepath.Join(home, ".mpanel")
}

// System is the [system] section of app.yaml. Field names follow 1Panel.
type System struct {
	Port        int    `yaml:"port"`
	BindAddress string `yaml:"bindAddress"`
	SSL         string `yaml:"ssl"`
	BaseDir     string `yaml:"base_dir"`
	DataDir     string `yaml:"data_dir"`
	LogPath     string `yaml:"log_path"`
	DBFile      string `yaml:"db_file"`
	DBPath      string `yaml:"db_path"`
	BackupDir   string `yaml:"backup"`
	TmpDir      string `yaml:"tmp_dir"`
	WebDir      string `yaml:"web_dir"`
	CorsOrigins string `yaml:"cors_origins"`
	Username    string `yaml:"username"`
	Password    string `yaml:"password"`
	Secret      string `yaml:"secret"`
	Version     string `yaml:"version"`
	Entrance    string `yaml:"entrance"`
	Language    string `yaml:"language"`
}

// Log is the [log] section.
type Log struct {
	Level string `yaml:"level"`
}

// App is the core configuration document.
type App struct {
	System System `yaml:"system"`
	Log    Log    `yaml:"log"`
}

// AgentSystem is the [agent] section of agent.yaml.
type AgentSystem struct {
	Transport     string `yaml:"transport"`
	Listen        string `yaml:"listen"`
	Token         string `yaml:"token"`
	CoreURL       string `yaml:"core_url"`
	MachineID     string `yaml:"machine_id"`
	MachineSecret string `yaml:"machine_secret"`
	EdgeKey       string `yaml:"edge_key"`
	BaseDir       string `yaml:"base_dir"`
	DataDir       string `yaml:"data_dir"`
	LogPath       string `yaml:"log_path"`
	Version       string `yaml:"version"`
	// CaddyBin/CaddyConfig/CaddyData and friends let a deployment point the
	// agent at host tooling without editing code.
	CaddyBin    string `yaml:"caddy_bin"`
	CaddyConfig string `yaml:"caddy_config"`
	CaddyData   string `yaml:"caddy_data"`
	CaddyAdmin  string `yaml:"caddy_admin"`
	DockerBin   string `yaml:"docker_bin"`
	// DockerConfig is the daemon.json path read/written by the container
	// configuration page. Rootless deployments point it at
	// ~/.config/docker/daemon.json.
	DockerConfig string `yaml:"docker_config"`
	PGDumpBin    string `yaml:"pg_dump_bin"`
	PSQLBin      string `yaml:"psql_bin"`
	RedisCLIBin  string `yaml:"redis_cli_bin"`
	FilesRoots   []Root `yaml:"files_roots"`
}

// Root is one sandbox root of the file manager.
type Root struct {
	Name string `yaml:"name"`
	Path string `yaml:"path"`
}

// Agent is the agent configuration document.
type Agent struct {
	Agent AgentSystem `yaml:"agent"`
	Log   Log         `yaml:"log"`
}

// Version is the release version, overridable at build time with -ldflags.
var Version = "0.3.0"

// CorePath returns the config file path for core.
func CorePath(baseDir string) string { return filepath.Join(baseDir, "conf", "app.yaml") }

// AgentPath returns the config file path for the agent.
func AgentPath(baseDir string) string { return filepath.Join(baseDir, "conf", "agent.yaml") }

// NewApp returns a configuration with 1Panel-style defaults.
func NewApp(baseDir string) *App {
	if baseDir == "" {
		baseDir = DefaultBaseDir()
	}
	return &App{
		System: System{
			Port:        10086,
			BindAddress: "0.0.0.0",
			BaseDir:     baseDir,
			DataDir:     filepath.Join(baseDir, "data"),
			LogPath:     filepath.Join(baseDir, "log"),
			DBFile:      "core.db",
			DBPath:      filepath.Join(baseDir, "db"),
			BackupDir:   filepath.Join(baseDir, "backup"),
			TmpDir:      filepath.Join(baseDir, "tmp"),
			WebDir:      filepath.Join(baseDir, "web"),
			Secret:      RandomToken(32),
			Version:     Version,
			Language:    "zh",
		},
		Log: Log{Level: "info"},
	}
}

// NewAgent returns an agent configuration with defaults under the same base dir.
func NewAgent(baseDir string) *Agent {
	if baseDir == "" {
		baseDir = DefaultBaseDir()
	}
	return &Agent{
		Agent: AgentSystem{
			Transport:    "http",
			Listen:       "0.0.0.0:10087",
			BaseDir:      baseDir,
			DataDir:      filepath.Join(baseDir, "data", "agent"),
			LogPath:      filepath.Join(baseDir, "log"),
			Version:      Version,
			CaddyBin:     "caddy",
			DockerBin:    "docker",
			DockerConfig: "/etc/docker/daemon.json",
			PGDumpBin:    "pg_dump",
			PSQLBin:      "psql",
			RedisCLIBin:  "redis-cli",
			FilesRoots:   []Root{{Name: "files", Path: filepath.Join(baseDir, "data", "files")}},
		},
		Log: Log{Level: "info"},
	}
}

// LoadApp reads app.yaml, creating it from defaults when missing, then applies
// MPANEL_* overrides. The file is written with mode 0600 because it holds the
// session secret and the password hash.
func LoadApp(baseDir string) (*App, error) {
	path := CorePath(baseDir)
	cfg := NewApp(baseDir)
	if data, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("解析 %s 失败: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	applyAppEnv(cfg)
	cfg.normalize()
	if err := SaveApp(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// SaveApp writes app.yaml atomically with 0600.
func SaveApp(cfg *App) error {
	path := CorePath(cfg.System.BaseDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, data, 0o600)
}

// LoadAgent reads agent.yaml, creating it from defaults when missing.
func LoadAgent(baseDir string) (*Agent, error) {
	path := AgentPath(baseDir)
	cfg := NewAgent(baseDir)
	if data, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("解析 %s 失败: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	applyAgentEnv(cfg)
	cfg.normalize()
	if err := SaveAgent(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// SaveAgent writes agent.yaml atomically with 0600.
func SaveAgent(cfg *Agent) error {
	path := AgentPath(cfg.Agent.BaseDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, data, 0o600)
}

func (cfg *App) normalize() {
	s := &cfg.System
	if s.BaseDir == "" {
		s.BaseDir = DefaultBaseDir()
	}
	if s.DataDir == "" {
		s.DataDir = filepath.Join(s.BaseDir, "data")
	}
	if s.LogPath == "" {
		s.LogPath = filepath.Join(s.BaseDir, "log")
	}
	if s.DBPath == "" {
		s.DBPath = filepath.Join(s.BaseDir, "db")
	}
	if s.DBFile == "" {
		s.DBFile = "core.db"
	}
	if s.BackupDir == "" {
		s.BackupDir = filepath.Join(s.BaseDir, "backup")
	}
	if s.TmpDir == "" {
		s.TmpDir = filepath.Join(s.BaseDir, "tmp")
	}
	if s.WebDir == "" {
		s.WebDir = filepath.Join(s.BaseDir, "web")
	}
	if s.BindAddress == "" {
		s.BindAddress = "0.0.0.0"
	}
	if s.Port == 0 {
		s.Port = 10086
	}
	if s.Secret == "" {
		s.Secret = RandomToken(32)
	}
	if s.Version == "" {
		s.Version = Version
	}
	if cfg.Log.Level == "" {
		cfg.Log.Level = "info"
	}
}

func (cfg *Agent) normalize() {
	a := &cfg.Agent
	if a.BaseDir == "" {
		a.BaseDir = DefaultBaseDir()
	}
	if a.DataDir == "" {
		a.DataDir = filepath.Join(a.BaseDir, "data", "agent")
	}
	if a.LogPath == "" {
		a.LogPath = filepath.Join(a.BaseDir, "log")
	}
	if a.Transport == "" {
		a.Transport = "http"
	}
	if a.Listen == "" {
		a.Listen = "0.0.0.0:10087"
	}
	if a.CaddyBin == "" {
		a.CaddyBin = "caddy"
	}
	if a.DockerBin == "" {
		a.DockerBin = "docker"
	}
	if a.DockerConfig == "" {
		a.DockerConfig = "/etc/docker/daemon.json"
	}
	if a.PGDumpBin == "" {
		a.PGDumpBin = "pg_dump"
	}
	if a.PSQLBin == "" {
		a.PSQLBin = "psql"
	}
	if a.RedisCLIBin == "" {
		a.RedisCLIBin = "redis-cli"
	}
	if len(a.FilesRoots) == 0 {
		a.FilesRoots = []Root{{Name: "files", Path: filepath.Join(a.BaseDir, "data", "files")}}
	}
	if a.Version == "" {
		a.Version = Version
	}
	if cfg.Log.Level == "" {
		cfg.Log.Level = "info"
	}
}

func applyAppEnv(cfg *App) {
	s := &cfg.System
	str := func(key string, dst *string) {
		if v := os.Getenv(key); v != "" {
			*dst = v
		}
	}
	str("MPANEL_BASE_DIR", &s.BaseDir)
	str("MPANEL_BIND_ADDRESS", &s.BindAddress)
	str("MPANEL_DATA_DIR", &s.DataDir)
	str("MPANEL_LOG_PATH", &s.LogPath)
	str("MPANEL_DB_PATH", &s.DBPath)
	str("MPANEL_BACKUP", &s.BackupDir)
	str("MPANEL_TMP_DIR", &s.TmpDir)
	str("MPANEL_WEB_DIR", &s.WebDir)
	str("MPANEL_CORS_ORIGINS", &s.CorsOrigins)
	str("MPANEL_SECRET", &s.Secret)
	str("MPANEL_USERNAME", &s.Username)
	str("MPANEL_PASSWORD", &s.Password)
	str("MPANEL_LOG_LEVEL", &cfg.Log.Level)
	if v := os.Getenv("MPANEL_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil && port > 0 && port <= 65535 {
			s.Port = port
		}
	}
}

func applyAgentEnv(cfg *Agent) {
	a := &cfg.Agent
	str := func(key string, dst *string) {
		if v := os.Getenv(key); v != "" {
			*dst = v
		}
	}
	str("MPANEL_AGENT_BASE_DIR", &a.BaseDir)
	str("MPANEL_AGENT_LISTEN", &a.Listen)
	str("MPANEL_AGENT_TOKEN", &a.Token)
	str("MPANEL_AGENT_TRANSPORT", &a.Transport)
	str("MPANEL_CORE_URL", &a.CoreURL)
	str("MPANEL_MACHINE_ID", &a.MachineID)
	str("MPANEL_MACHINE_SECRET", &a.MachineSecret)
	str("MPANEL_EDGE_KEY", &a.EdgeKey)
	str("MPANEL_CADDY_BIN", &a.CaddyBin)
	str("MPANEL_CADDY_CONFIG", &a.CaddyConfig)
	str("MPANEL_CADDY_DATA", &a.CaddyData)
	str("MPANEL_CADDY_ADMIN", &a.CaddyAdmin)
	str("MPANEL_DOCKER_BIN", &a.DockerBin)
	str("MPANEL_DOCKER_CONFIG", &a.DockerConfig)
	str("MPANEL_PG_DUMP_BIN", &a.PGDumpBin)
	str("MPANEL_PSQL_BIN", &a.PSQLBin)
	str("MPANEL_REDIS_CLI_BIN", &a.RedisCLIBin)
	str("MPANEL_AGENT_DATA_DIR", &a.DataDir)
	str("MPANEL_LOG_LEVEL", &cfg.Log.Level)
	if v := os.Getenv("MPANEL_FILES_ROOTS"); v != "" {
		a.FilesRoots = ParseRoots(v)
	}
}

// ParseRoots parses "name=/abs/path[,name=/abs/path]" into sandbox roots.
func ParseRoots(value string) []Root {
	var roots []Root
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, path, ok := strings.Cut(part, "=")
		if !ok {
			name, path = "files", part
		}
		name = strings.TrimSpace(name)
		path = strings.TrimSpace(path)
		if name == "" || path == "" {
			continue
		}
		roots = append(roots, Root{Name: name, Path: path})
	}
	return roots
}

// EnsureDirs creates the standard directory tree with restrictive modes.
func (cfg *App) EnsureDirs() error {
	s := cfg.System
	for _, dir := range []string{
		filepath.Join(s.BaseDir, "conf"),
		s.DataDir, s.LogPath, s.DBPath, s.BackupDir, s.TmpDir,
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// EnsureDirs creates the agent directory tree, including file sandbox roots.
func (cfg *Agent) EnsureDirs() error {
	a := cfg.Agent
	dirs := []string{
		filepath.Join(a.BaseDir, "conf"),
		a.DataDir, a.LogPath,
		filepath.Join(a.DataDir, "sites"),
		filepath.Join(a.DataDir, "backups"),
		filepath.Join(a.DataDir, "trash"),
		filepath.Join(a.DataDir, "tasks"),
	}
	for _, root := range a.FilesRoots {
		dirs = append(dirs, root.Path)
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// CaddyDirs resolves the managed Caddy configuration/data directories.
func (cfg *Agent) CaddyDirs() (confDir, dataDir string) {
	confDir = cfg.Agent.CaddyConfig
	if confDir == "" {
		confDir = filepath.Join(cfg.Agent.DataDir, "caddy")
	}
	dataDir = cfg.Agent.CaddyData
	if dataDir == "" {
		dataDir = filepath.Join(confDir, "data")
	}
	return confDir, dataDir
}

// RandomToken returns a URL-safe random token of n bytes entropy.
func RandomToken(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failure is unrecoverable for a panel that signs sessions.
		panic("crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// WriteFileAtomic writes data via tmp + fsync + rename with the given mode.
func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

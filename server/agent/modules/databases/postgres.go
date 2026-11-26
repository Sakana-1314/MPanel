package databases

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// postgresDSN builds a lib/pq URL DSN. The password only ever lives in the
// in-process DSN string handed to the driver.
func postgresDSN(profile profileRecord, password string) string {
	host := net.JoinHostPort(dialHost(profile.Host), strconv.Itoa(profile.Port))
	dsn := &url.URL{
		Scheme: "postgres",
		Host:   host,
		Path:   "/" + profile.dbName(),
	}
	if user := profile.usernameValue(); user != "" {
		if password != "" {
			dsn.User = url.UserPassword(user, password)
		} else {
			dsn.User = url.User(user)
		}
	}
	query := dsn.Query()
	if profile.TLS {
		query.Set("sslmode", "require")
	} else {
		query.Set("sslmode", "disable")
	}
	query.Set("connect_timeout", "8")
	query.Set("application_name", "mpanel-agent")
	dsn.RawQuery = query.Encode()
	return dsn.String()
}

func openPostgres(profile profileRecord, password string) (*sql.DB, error) {
	db, err := sql.Open("postgres", postgresDSN(profile, password))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(time.Minute)
	return db, nil
}

// testPostgres connects, runs select version() and reports latency. A target
// that refuses the connection is a normal ok:false result, not an error.
func (m *Module) testPostgres(ctx context.Context, profile profileRecord, password string) (DatabaseTestResult, error) {
	started := time.Now()
	db, err := openPostgres(profile, password)
	if err != nil {
		return DatabaseTestResult{}, &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "PostgreSQL 驱动不可用",
			Hint:    "确认 agent 构建包含 lib/pq 驱动后重试。",
		}
	}
	defer db.Close()

	runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var version string
	err = db.PingContext(runCtx)
	if err == nil {
		err = db.QueryRowContext(runCtx, "SELECT version()").Scan(&version)
	}
	latency := time.Since(started).Milliseconds()
	result := DatabaseTestResult{LatencyMs: latency}
	if err != nil {
		result.Message = truncateText(redactSecret(err.Error(), password), 300)
		return result, nil
	}
	result.OK = true
	result.ServerVersion = truncateText(version, 200)
	return result, nil
}

// collectPostgresStats reads version, uptime, size, connections, cache hit
// ratio and the longest open transaction.
func collectPostgresStats(ctx context.Context, db *sql.DB) (PostgresStats, error) {
	stats := PostgresStats{Kind: kindPostgres}
	var version string
	if err := db.QueryRowContext(ctx,
		`SELECT current_setting('server_version'),
		        EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint,
		        pg_database_size(current_database())::bigint`).
		Scan(&version, &stats.UptimeSec, &stats.DatabaseSizeBytes); err != nil {
		return stats, fmt.Errorf("读取 PostgreSQL 基本信息失败: %w", err)
	}
	stats.Version = version

	if err := db.QueryRowContext(ctx,
		`SELECT count(*)::bigint,
		        count(*) FILTER (WHERE state = 'active')::bigint,
		        count(*) FILTER (WHERE state = 'idle')::bigint,
		        count(*) FILTER (WHERE state = 'idle in transaction')::bigint
		   FROM pg_stat_activity`).
		Scan(&stats.Connections.Total, &stats.Connections.Active, &stats.Connections.Idle, &stats.Connections.IdleInTransaction); err != nil {
		return stats, fmt.Errorf("读取 PostgreSQL 连接统计失败: %w", err)
	}

	var hits, reads int64
	if err := db.QueryRowContext(ctx,
		`SELECT COALESCE(sum(blks_hit), 0)::bigint, COALESCE(sum(blks_read), 0)::bigint
		   FROM pg_stat_database
		  WHERE datname = current_database()`).
		Scan(&hits, &reads); err != nil {
		return stats, fmt.Errorf("读取 PostgreSQL 缓存统计失败: %w", err)
	}
	if total := hits + reads; total > 0 {
		ratio := float64(hits) / float64(total)
		stats.CacheHitRatio = &ratio
	}

	var longest float64
	if err := db.QueryRowContext(ctx,
		`SELECT COALESCE(max(EXTRACT(EPOCH FROM (now() - xact_start))), 0)::float8
		   FROM pg_stat_activity
		  WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()`).
		Scan(&longest); err != nil {
		return stats, fmt.Errorf("读取 PostgreSQL 事务统计失败: %w", err)
	}
	stats.LongestTransactionSec = longest
	return stats, nil
}

func (m *Module) postgresStats(ctx context.Context, profile profileRecord, password string) (PostgresStats, error) {
	db, err := openPostgres(profile, password)
	if err != nil {
		return PostgresStats{}, &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "PostgreSQL 驱动不可用",
			Hint:    "确认 agent 构建包含 lib/pq 驱动后重试。",
		}
	}
	defer db.Close()

	runCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if err := db.PingContext(runCtx); err != nil {
		return PostgresStats{}, redactedUpstream("连接 PostgreSQL 失败", err, password)
	}
	stats, err := collectPostgresStats(runCtx, db)
	if err != nil {
		return PostgresStats{}, redactedUpstream("读取 PostgreSQL 统计失败", err, password)
	}
	return stats, nil
}

// pgDumpBin resolves the configured pg_dump executable.
func (m *Module) pgDumpBin() string {
	if m.cfg != nil {
		if bin := strings.TrimSpace(m.cfg.Agent.PGDumpBin); bin != "" {
			return bin
		}
	}
	return "pg_dump"
}

// psqlBin resolves the configured psql executable.
func (m *Module) psqlBin() string {
	if m.cfg != nil {
		if bin := strings.TrimSpace(m.cfg.Agent.PSQLBin); bin != "" {
			return bin
		}
	}
	return "psql"
}

// pgRestoreBin derives pg_restore from the configured pg_dump path so both
// live in the same version-specific bin directory.
func (m *Module) pgRestoreBin() string {
	return deriveSibling(m.pgDumpBin(), "pg_dump", "pg_restore")
}

// ensureTool verifies a PostgreSQL client executable exists. Profiles stay
// manageable when it is missing; only backup/restore return UNAVAILABLE.
func (m *Module) ensureTool(ctx context.Context, bin, label, hint string) error {
	if m.runner == nil {
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: label + " 不可用",
			Hint:    hint,
			Details: map[string]any{"capability": label},
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	result, err := m.runner.RunTimeout(runCtx, 5*time.Second, bin, "--version")
	if err != nil || result.Code != 0 {
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: label + " 不可用",
			Hint:    hint,
			Details: map[string]any{"capability": label},
		}
	}
	return nil
}

// pgConnectionArgs builds the connection flags shared by pg_dump, pg_restore
// and psql. On Unix the password travels through a one-shot PGPASSFILE; on
// Windows (development only) it is embedded in a URL DSN because there is no
// `env` executable to set the variable with an argument array.
func (m *Module) pgConnectionArgs(profile profileRecord, password string) []string {
	if runtime.GOOS == "windows" && password != "" {
		return []string{"--dbname=" + postgresDSN(profile, password)}
	}
	args := []string{
		"--host=" + dialHost(profile.Host),
		"--port=" + strconv.Itoa(profile.Port),
		"--dbname=" + profile.dbName(),
	}
	if user := profile.usernameValue(); user != "" {
		args = append(args, "--username="+user)
	}
	if profile.TLS {
		args = append(args, "--sslmode=require")
	} else {
		args = append(args, "--sslmode=disable")
	}
	return args
}

func (m *Module) pgDumpArgs(profile profileRecord, format, file, password string) []string {
	args := []string{
		"--format=" + format,
		"--no-password",
		"--file=" + file,
	}
	return append(args, m.pgConnectionArgs(profile, password)...)
}

func (m *Module) pgRestoreArgs(profile profileRecord, format, file, password string) []string {
	if format == formatPlain {
		args := []string{"--no-password", "--set=ON_ERROR_STOP=on"}
		args = append(args, m.pgConnectionArgs(profile, password)...)
		return append(args, "--file="+file)
	}
	args := []string{"--clean", "--if-exists", "--no-owner", "--no-password"}
	args = append(args, m.pgConnectionArgs(profile, password)...)
	return append(args, file)
}

// writePGPass creates a 0600 pgpass file so the password never appears on a
// command line.
func (m *Module) writePGPass(password string) (string, func(), error) {
	if strings.ContainsAny(password, "\r\n") {
		return "", nil, errors.New("密码包含换行符，无法通过 pgpass 传递")
	}
	dir := filepath.Join(m.dataDir, "tmp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", nil, err
	}
	file, err := os.CreateTemp(dir, "pgpass-*")
	if err != nil {
		return "", nil, err
	}
	path := file.Name()
	cleanup := func() { _ = os.Remove(path) }
	escape := strings.NewReplacer(`\`, `\\`, ":", `\:`).Replace(password)
	if _, err := fmt.Fprintf(file, "*:*:*:*:%s\n", escape); err != nil {
		file.Close()
		cleanup()
		return "", nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		cleanup()
		return "", nil, err
	}
	if err := file.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return path, cleanup, nil
}

// runPG runs a PostgreSQL client with the password supplied out of band. The
// agent's Runner has no env support, so `env` (an argument-array exec, never a
// shell) bridges PGPASSFILE on Unix.
func (m *Module) runPG(ctx context.Context, timeout time.Duration, bin string, args []string, password string) (agent.Result, error) {
	if m.runner == nil {
		return agent.Result{}, errors.New("命令执行器不可用")
	}
	if password != "" && runtime.GOOS != "windows" {
		passFile, cleanup, err := m.writePGPass(password)
		if err != nil {
			return agent.Result{}, err
		}
		defer cleanup()
		full := append([]string{"PGPASSFILE=" + passFile, "PGCONNECT_TIMEOUT=8", bin}, args...)
		return m.runner.RunTimeout(ctx, timeout, "env", full...)
	}
	return m.runner.RunTimeout(ctx, timeout, bin, args...)
}

// backupPostgres runs pg_dump into dest and returns the file size.
func (m *Module) backupPostgres(ctx context.Context, profile profileRecord, password, format, dest string) (int64, error) {
	args := m.pgDumpArgs(profile, format, dest, password)
	result, err := m.runPG(ctx, 30*time.Minute, m.pgDumpBin(), args, password)
	if err != nil {
		return 0, fmt.Errorf("启动 pg_dump 失败: %w", err)
	}
	if result.Code != 0 {
		return 0, fmt.Errorf("pg_dump 失败（退出码 %d）: %s", result.Code, commandOutput(result, password))
	}
	size, err := fileSize(dest)
	if err != nil {
		return 0, fmt.Errorf("pg_dump 未生成备份文件: %w", err)
	}
	if size == 0 {
		return 0, errors.New("pg_dump 生成了空备份文件")
	}
	return size, nil
}

// restorePostgres restores a custom-format backup with pg_restore and a plain
// SQL backup with psql.
func (m *Module) restorePostgres(ctx context.Context, profile profileRecord, password string, backup backupEntry) error {
	var (
		bin  string
		args []string
	)
	switch backup.Format {
	case formatCustom:
		bin = m.pgRestoreBin()
		args = m.pgRestoreArgs(profile, formatCustom, backup.Path, password)
	case formatPlain:
		bin = m.psqlBin()
		args = m.pgRestoreArgs(profile, formatPlain, backup.Path, password)
	default:
		return protocol.BadRequest("不支持的 PostgreSQL 备份格式")
	}
	result, err := m.runPG(ctx, 30*time.Minute, bin, args, password)
	if err != nil {
		return fmt.Errorf("启动恢复命令失败: %w", err)
	}
	if result.Code != 0 {
		return fmt.Errorf("恢复失败（退出码 %d）: %s", result.Code, commandOutput(result, password))
	}
	return nil
}

// commandOutput renders a command's stderr (falling back to stdout) for a job
// error, redacting the password and truncating so a huge dump log cannot fill
// the jobs file.
func commandOutput(result agent.Result, secret string) string {
	output := strings.TrimSpace(result.Stderr)
	if output == "" {
		output = strings.TrimSpace(result.Stdout)
	}
	if secret != "" {
		output = strings.ReplaceAll(output, secret, "***")
	}
	if output == "" {
		return "无输出"
	}
	return truncateText(output, 400)
}

// upstreamError wraps a target failure as 502 UPSTREAM_ERROR without leaking a
// DSN or SQL statement.
func upstreamError(message string, err error) *protocol.PanelError {
	apiErr := &protocol.PanelError{Code: protocol.CodeUpstreamError, Message: message}
	if err != nil {
		apiErr.Details = map[string]any{"message": truncateText(err.Error(), 300)}
	}
	return apiErr
}

// redactedUpstream additionally removes the profile password from the detail
// string, in case a driver includes it in an error.
func redactedUpstream(message string, err error, secret string) *protocol.PanelError {
	apiErr := upstreamError(message, err)
	if secret == "" || apiErr.Details == nil {
		return apiErr
	}
	if text, ok := apiErr.Details["message"].(string); ok {
		apiErr.Details["message"] = redactSecret(text, secret)
	}
	return apiErr
}

// redactSecret replaces a literal secret in an error string.
func redactSecret(text, secret string) string {
	if secret == "" {
		return text
	}
	return strings.ReplaceAll(text, secret, "***")
}

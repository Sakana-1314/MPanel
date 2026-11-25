package databases

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// newRedisClient builds a short-lived client for one operation. TLS uses the
// profile host as ServerName so certificate verification stays meaningful.
func newRedisClient(profile profileRecord, password string) *redis.Client {
	options := &redis.Options{
		Addr:         net.JoinHostPort(dialHost(profile.Host), strconv.Itoa(profile.Port)),
		Username:     profile.usernameValue(),
		Password:     password,
		DB:           0,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  8 * time.Second,
		WriteTimeout: 8 * time.Second,
		MaxRetries:   0,
	}
	if profile.RedisDB != nil {
		options.DB = *profile.RedisDB
	}
	if profile.TLS {
		options.TLSConfig = &tls.Config{
			ServerName: dialHost(profile.Host),
			MinVersion: tls.VersionTLS12,
		}
	}
	return redis.NewClient(options)
}

// testRedis pings the target and reads the server version. Unreachable targets
// are reported as ok:false, not as an error.
func (m *Module) testRedis(ctx context.Context, profile profileRecord, password string) (DatabaseTestResult, error) {
	client := newRedisClient(profile, password)
	defer client.Close()

	runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	started := time.Now()
	err := client.Ping(runCtx).Err()
	version := ""
	if err == nil {
		if raw, infoErr := client.Info(runCtx, "server").Result(); infoErr == nil {
			version = parseRedisInfo(raw)["redis_version"]
		}
	}
	latency := time.Since(started).Milliseconds()
	result := DatabaseTestResult{LatencyMs: latency}
	if err != nil {
		result.Message = truncateText(err.Error(), 300)
		return result, nil
	}
	result.OK = true
	result.ServerVersion = version
	return result, nil
}

// redisStats reads INFO and (best effort) SLOWLOG.
func (m *Module) redisStats(ctx context.Context, profile profileRecord, password string) (RedisStats, error) {
	client := newRedisClient(profile, password)
	defer client.Close()

	runCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()

	if err := client.Ping(runCtx).Err(); err != nil {
		return RedisStats{}, upstreamError("连接 Redis 失败", err)
	}
	raw, err := client.Info(runCtx, "all").Result()
	if err != nil {
		return RedisStats{}, upstreamError("读取 Redis INFO 失败", err)
	}
	info := parseRedisInfo(raw)
	slowlog := fetchRedisSlowlog(runCtx, client)
	return buildRedisStats(info, slowlog), nil
}

// parseRedisInfo turns INFO text into a key/value map. Duplicate sections are
// merged; the last value wins, which matches Redis' own layout.
func parseRedisInfo(raw string) map[string]string {
	info := make(map[string]string)
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		info[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return info
}

// buildRedisStats is pure so it can be tested without a server.
func buildRedisStats(info map[string]string, slowlog []redisSlowlogEntry) RedisStats {
	stats := RedisStats{
		Kind:             kindRedis,
		Version:          info["redis_version"],
		UptimeSec:        parseInt64(info["uptime_in_seconds"]),
		Role:             redisRole(info["role"]),
		ConnectedClients: parseInt64(info["connected_clients"]),
		UsedMemoryBytes:  parseInt64(info["used_memory"]),
		Keyspace:         parseRedisKeyspace(info),
		Slowlog:          slowlog,
	}
	if raw, ok := info["maxmemory"]; ok {
		if value := parseInt64(raw); value > 0 {
			stats.MaxMemoryBytes = int64Ptr(value, true)
		}
	}
	if raw, ok := info["instantaneous_ops_per_sec"]; ok {
		stats.OpsPerSec = int64Ptr(parseInt64(raw), true)
	}
	if hits, ok := info["keyspace_hits"]; ok {
		deleteCount := parseInt64(info["keyspace_misses"])
		total := parseInt64(hits) + deleteCount
		if total > 0 {
			ratio := float64(parseInt64(hits)) / float64(total)
			stats.CacheHitRatio = &ratio
		}
	}
	for _, entry := range stats.Keyspace {
		stats.TotalKeys += entry.Keys
	}
	if stats.Keyspace == nil {
		stats.Keyspace = []redisKeyspaceEntry{}
	}
	return stats
}

func redisRole(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "master":
		return "master"
	case "slave", "replica":
		return "replica"
	case "sentinel":
		return "sentinel"
	default:
		return "unknown"
	}
}

// parseRedisKeyspace reads the "dbN:keys=..,expires=..,avg_ttl=.." lines.
func parseRedisKeyspace(info map[string]string) []redisKeyspaceEntry {
	entries := make([]redisKeyspaceEntry, 0)
	for key, value := range info {
		if !strings.HasPrefix(key, "db") {
			continue
		}
		db, err := strconv.Atoi(key[2:])
		if err != nil {
			continue
		}
		fields := make(map[string]string)
		for _, part := range strings.Split(value, ",") {
			name, fieldValue, ok := strings.Cut(part, "=")
			if !ok {
				continue
			}
			fields[strings.TrimSpace(name)] = strings.TrimSpace(fieldValue)
		}
		entries = append(entries, redisKeyspaceEntry{
			DB:      db,
			Keys:    parseInt64(fields["keys"]),
			Expires: parseInt64(fields["expires"]),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].DB < entries[j].DB })
	return entries
}

// fetchRedisSlowlog keeps command names only: SLOWLOG arguments frequently
// contain passwords and must never reach the panel.
func fetchRedisSlowlog(ctx context.Context, client *redis.Client) []redisSlowlogEntry {
	entries, err := client.SlowLogGet(ctx, 10).Result()
	if err != nil || len(entries) == 0 {
		return nil
	}
	out := make([]redisSlowlogEntry, 0, len(entries))
	for _, entry := range entries {
		command := ""
		if len(entry.Args) > 0 {
			command = strings.ToUpper(entry.Args[0])
		}
		out = append(out, redisSlowlogEntry{
			ID:         entry.ID,
			At:         stampAt(entry.Time),
			DurationMs: entry.Duration.Milliseconds(),
			Command:    command,
		})
	}
	return out
}

// backupRedis writes an RDB copy or a logical DUMP/RESTORE stream.
func (m *Module) backupRedis(ctx context.Context, profile profileRecord, password, format, dest string) (int64, error) {
	client := newRedisClient(profile, password)
	defer client.Close()
	if err := client.Ping(ctx).Err(); err != nil {
		return 0, fmt.Errorf("连接 Redis 失败: %w", err)
	}

	switch format {
	case formatRDB:
		if err := m.redisRDBBackup(ctx, client, dest); err != nil {
			return 0, err
		}
	case formatLogical:
		size, skipped, err := m.redisLogicalBackup(ctx, client, dest)
		if err != nil {
			return 0, err
		}
		if skipped > 0 {
			m.logWarn("逻辑备份跳过了部分 key", "profileId", profile.ID, "skipped", skipped)
		}
		return size, nil
	default:
		return 0, fmt.Errorf("不支持的 Redis 备份格式 %q", format)
	}
	return fileSize(dest)
}

// redisRDBBackup triggers BGSAVE, waits for it to finish, then copies the RDB
// from the directory Redis reports.
func (m *Module) redisRDBBackup(ctx context.Context, client *redis.Client, dest string) error {
	if err := client.BgSave(ctx).Err(); err != nil && !isBackgroundSaveInProgress(err) {
		return fmt.Errorf("触发 BGSAVE 失败: %w", err)
	}
	deadline := time.Now().Add(2 * time.Minute)
	for {
		raw, err := client.Info(ctx, "persistence").Result()
		if err != nil {
			return fmt.Errorf("读取 Redis 持久化状态失败: %w", err)
		}
		info := parseRedisInfo(raw)
		if info["rdb_bgsave_in_progress"] == "0" {
			if status := info["rdb_last_bgsave_status"]; status != "" && status != "ok" {
				return fmt.Errorf("Redis BGSAVE 失败，状态 %s", status)
			}
			break
		}
		if time.Now().After(deadline) {
			return errors.New("等待 Redis BGSAVE 超时")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}

	dirs, err := client.ConfigGet(ctx, "dir").Result()
	if err != nil {
		return fmt.Errorf("读取 Redis dir 配置失败: %w", err)
	}
	files, err := client.ConfigGet(ctx, "dbfilename").Result()
	if err != nil {
		return fmt.Errorf("读取 Redis dbfilename 配置失败: %w", err)
	}
	dir := strings.TrimSpace(dirs["dir"])
	filename := strings.TrimSpace(files["dbfilename"])
	if dir == "" || filename == "" {
		return errors.New("Redis 未返回 dir 或 dbfilename")
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("Redis dir 不是绝对路径: %s", dir)
	}
	source := filepath.Join(dir, filename)
	if _, err := os.Stat(source); err != nil {
		return fmt.Errorf("找不到 Redis RDB 文件: %w", err)
	}
	if _, err := copyFile(dest, source); err != nil {
		return fmt.Errorf("复制 RDB 文件失败: %w", err)
	}
	return nil
}

func isBackgroundSaveInProgress(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "progress")
}

// logicalEntry is one line of a logical Redis backup. Payload is the binary
// DUMP value, JSON-encoded as base64.
type logicalEntry struct {
	Key     string `json:"key"`
	TTLMs   int64  `json:"ttlMs"` // -1 means no expiry
	Payload []byte `json:"payload"`
}

// redisLogicalBackup scans every key and streams DUMP payloads to dest.
func (m *Module) redisLogicalBackup(ctx context.Context, client *redis.Client, dest string) (int64, int, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return 0, 0, err
	}
	file, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()

	writer := bufio.NewWriterSize(file, 256*1024)
	encoder := json.NewEncoder(writer)
	skipped := 0
	cursor := uint64(0)
	for {
		keys, next, scanErr := client.Scan(ctx, cursor, "*", 500).Result()
		if scanErr != nil {
			return 0, skipped, fmt.Errorf("SCAN 失败: %w", scanErr)
		}
		for _, key := range keys {
			payload, dumpErr := client.Dump(ctx, key).Bytes()
			if dumpErr != nil {
				// Module-specific or concurrently deleted keys are skipped.
				skipped++
				continue
			}
			ttl := client.PTTL(ctx, key).Val()
			var ttlMs int64
			switch {
			case ttl == -2:
				// The key disappeared between DUMP and PTTL; never resurrect it
				// without an expiry.
				skipped++
				continue
			case ttl < 0:
				ttlMs = -1
			case ttl == 0:
				ttlMs = 1
			default:
				ttlMs = ttl.Milliseconds()
			}
			if encodeErr := encoder.Encode(logicalEntry{Key: key, TTLMs: ttlMs, Payload: payload}); encodeErr != nil {
				return 0, skipped, encodeErr
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	if err := writer.Flush(); err != nil {
		return 0, skipped, err
	}
	if err := file.Sync(); err != nil {
		return 0, skipped, err
	}
	size, err := fileSize(dest)
	return size, skipped, err
}

// restoreRedisLogical replays a logical backup with RESTORE REPLACE. Keys that
// fail (for example module keys missing on the target) are skipped and logged.
func (m *Module) restoreRedisLogical(ctx context.Context, client *redis.Client, source string) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()

	decoder := json.NewDecoder(bufio.NewReaderSize(file, 256*1024))
	total, restored, failed := 0, 0, 0
	firstError := ""
	for {
		var entry logicalEntry
		decodeErr := decoder.Decode(&entry)
		if errors.Is(decodeErr, io.EOF) {
			break
		}
		if decodeErr != nil {
			return fmt.Errorf("解析逻辑备份失败: %w", decodeErr)
		}
		total++
		var ttl time.Duration
		if entry.TTLMs > 0 {
			ttl = time.Duration(entry.TTLMs) * time.Millisecond
		}
		if restoreErr := client.RestoreReplace(ctx, entry.Key, ttl, string(entry.Payload)).Err(); restoreErr != nil {
			failed++
			if firstError == "" {
				firstError = truncateText(restoreErr.Error(), 200)
			}
			continue
		}
		restored++
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if total > 0 && restored == 0 && failed > 0 {
		return fmt.Errorf("所有 key 恢复失败: %s", firstError)
	}
	if failed > 0 {
		m.logWarn("部分 key 恢复失败", "total", total, "failed", failed, "error", firstError)
	}
	return nil
}

// restoreRedis restores a logical backup. RDB restore is offline-only and is
// rejected by the handler with UNAVAILABLE.
func (m *Module) restoreRedis(ctx context.Context, profile profileRecord, password string, backup backupEntry) error {
	if backup.Format != formatLogical {
		return errors.New("RDB 备份只能离线恢复")
	}
	client := newRedisClient(profile, password)
	defer client.Close()
	if err := client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("连接 Redis 失败: %w", err)
	}
	return m.restoreRedisLogical(ctx, client, backup.Path)
}

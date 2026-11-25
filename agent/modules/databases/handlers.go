package databases

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/internal/httpapi"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

// pageQuery reads the shared limit/cursor pagination parameters.
func pageQuery(r *http.Request) (int, string) {
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	return limit, r.URL.Query().Get("cursor")
}

func pageResult[T any](all []T, r *http.Request) protocol.ListResult[T] {
	limit, cursor := pageQuery(r)
	items, next, total := protocol.Page(all, limit, cursor)
	if items == nil {
		items = []T{}
	}
	return protocol.ListResult[T]{Available: true, Items: items, NextCursor: next, Total: &total}
}

func (m *Module) handleProfileList(w http.ResponseWriter, r *http.Request) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind != "" {
		if err := validateKind(kind); err != nil {
			httpapi.Fail(w, err)
			return
		}
	}
	records := m.listProfiles(kind, strings.TrimSpace(r.URL.Query().Get("q")))
	views := make([]DatabaseProfile, 0, len(records))
	for _, record := range records {
		views = append(views, record.public())
	}
	httpapi.OK(w, pageResult(views, r))
}

func (m *Module) handleProfileCreate(w http.ResponseWriter, r *http.Request) {
	var input DatabaseProfileCreateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	profile, err := m.createProfile(input)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.Created(w, profile)
}

func (m *Module) handleProfileGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	record, ok := m.findProfile(id)
	if !ok {
		httpapi.Fail(w, protocol.NotFound("数据库档案", id))
		return
	}
	view := record.public()
	reveal := r.URL.Query().Get("reveal")
	if (reveal == "1" || strings.EqualFold(reveal, "true")) && record.PasswordEnc != "" {
		password, err := m.revealPassword(record)
		if err != nil {
			httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeInternal, Message: "无法解密数据库密码"})
			return
		}
		httpapi.OK(w, revealedProfile{DatabaseProfile: view, Password: &password})
		return
	}
	httpapi.OK(w, view)
}

func (m *Module) handleProfilePatch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var input DatabaseProfileUpdateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	profile, err := m.patchProfile(id, input)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, profile)
}

func (m *Module) handleProfileDelete(w http.ResponseWriter, r *http.Request) {
	if err := m.deleteProfile(r.PathValue("id")); err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, map[string]any{"deleted": true})
}

// passwordFor decrypts the stored password, mapping key failures to INTERNAL.
func (m *Module) passwordFor(record profileRecord) (string, error) {
	password, err := m.revealPassword(record)
	if err != nil {
		return "", &protocol.PanelError{Code: protocol.CodeInternal, Message: "无法解密数据库密码"}
	}
	return password, nil
}

func (m *Module) handleProfileTest(w http.ResponseWriter, r *http.Request) {
	record, ok := m.findProfile(r.PathValue("id"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("数据库档案", r.PathValue("id")))
		return
	}
	password, err := m.passwordFor(record)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	var result DatabaseTestResult
	switch record.Kind {
	case kindPostgres:
		result, err = m.testPostgres(r.Context(), record, password)
	case kindRedis:
		result, err = m.testRedis(r.Context(), record, password)
	default:
		err = protocol.BadRequest("不支持的数据库类型")
	}
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	check := lastCheck{
		At:            nowStamp(),
		OK:            result.OK,
		LatencyMs:     result.LatencyMs,
		ServerVersion: result.ServerVersion,
		Message:       result.Message,
	}
	m.storeLastCheck(record.ID, check)
	httpapi.OK(w, result)
}

func (m *Module) handleProfileStats(w http.ResponseWriter, r *http.Request) {
	record, ok := m.findProfile(r.PathValue("id"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("数据库档案", r.PathValue("id")))
		return
	}
	password, err := m.passwordFor(record)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	var stats any
	switch record.Kind {
	case kindPostgres:
		stats, err = m.postgresStats(r.Context(), record, password)
	case kindRedis:
		stats, err = m.redisStats(r.Context(), record, password)
	default:
		err = protocol.BadRequest("不支持的数据库类型")
	}
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, stats)
}

func (m *Module) handleHandoff(w http.ResponseWriter, r *http.Request) {
	record, ok := m.findProfile(r.PathValue("id"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("数据库档案", r.PathValue("id")))
		return
	}
	var input handoffRequest
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	ttlSec := 60
	if input.TTLSec != nil {
		ttlSec = *input.TTLSec
	}
	if ttlSec < 10 || ttlSec > 300 {
		httpapi.Fail(w, protocol.BadRequest("ttlSec 必须在 10-300 秒之间"))
		return
	}
	ticket, expires, err := m.tickets.issue(record.ID, record.Kind, time.Duration(ttlSec)*time.Second)
	if err != nil {
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeInternal, Message: "生成 handoff 票据失败"})
		return
	}
	m.logInfo("已签发 dbx handoff 票据",
		"profileId", record.ID,
		"ticketHash", ticketFingerprint(ticket),
		"ttlSec", ttlSec)
	httpapi.OK(w, HandoffTicket{
		Ticket:    ticket,
		ExpiresAt: stampAt(expires),
		RedeemURL: handoffRedeemURL,
		Kind:      record.Kind,
	})
}

func (m *Module) handleRedeem(w http.ResponseWriter, r *http.Request) {
	m.applyRedeemCORS(w.Header(), r.Header.Get("Origin"))
	w.Header().Set("Pragma", "no-cache")

	clientIP := httpapi.ClientIP(r)
	if m.redeemLimiter != nil {
		allowed, retryAfter := m.redeemLimiter.Hit(clientIP)
		if !allowed {
			m.logWarn("dbx handoff redeem 触发限速", "ip", clientIP, "retryAfterSec", retryAfter)
			httpapi.Fail(w, &protocol.PanelError{
				Code:    protocol.CodeUnauthorized,
				Message: "请求过于频繁",
				Details: map[string]any{"retryAfterSec": retryAfter},
			})
			return
		}
		m.redeemLimiter.Cleanup()
	}

	var input redeemRequest
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	ticket := strings.TrimSpace(input.Ticket)
	entry, ok := m.tickets.redeem(ticket)
	if !ok {
		m.logInfo("dbx handoff redeem 失败", "ticketHash", ticketFingerprint(ticket), "ip", clientIP)
		httpapi.Fail(w, handoffError())
		return
	}
	record, ok := m.findProfile(entry.profileID)
	if !ok || record.Kind != entry.kind {
		m.logInfo("dbx handoff redeem 失败：档案已不存在",
			"profileId", entry.profileID,
			"ticketHash", ticketFingerprint(ticket),
			"ip", clientIP)
		httpapi.Fail(w, handoffError())
		return
	}
	password, err := m.passwordFor(record)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	payload := buildHandoffPayload(record, password)
	m.logInfo("dbx handoff redeem 成功",
		"profileId", record.ID,
		"ticketHash", ticketFingerprint(ticket),
		"ip", clientIP)
	httpapi.OK(w, payload)
}

// defaultBackupFormat follows contract §8.5: custom for PostgreSQL, logical
// for Redis.
func defaultBackupFormat(kind string) string {
	if kind == kindRedis {
		return formatLogical
	}
	return formatCustom
}

func validateBackupFormat(kind, format string) error {
	switch kind {
	case kindPostgres:
		if format == formatCustom || format == formatPlain {
			return nil
		}
	case kindRedis:
		if format == formatLogical || format == formatRDB {
			return nil
		}
	}
	return &protocol.PanelError{
		Code:    protocol.CodeBadRequest,
		Message: "备份格式与数据库类型不匹配",
		Details: map[string]any{"kind": kind, "format": format},
	}
}

func (m *Module) handleBackupCreate(w http.ResponseWriter, r *http.Request) {
	record, ok := m.findProfile(r.PathValue("id"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("数据库档案", r.PathValue("id")))
		return
	}
	var input backupRequest
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	format := strings.ToLower(strings.TrimSpace(input.Format))
	if format == "" {
		format = defaultBackupFormat(record.Kind)
	}
	if err := validateBackupFormat(record.Kind, format); err != nil {
		httpapi.Fail(w, err)
		return
	}
	if record.Kind == kindPostgres {
		if err := m.ensureTool(r.Context(), m.pgDumpBin(), "pg_dump",
			"安装 PostgreSQL 客户端，或把 MPANEL_PG_DUMP_BIN 指向 pg_dump 的绝对路径后重试。"); err != nil {
			httpapi.Fail(w, err)
			return
		}
	}
	password, err := m.passwordFor(record)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	backup, job, err := m.beginBackup(record, format, input.Label)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	go m.runBackupJob(record, backup, job, password)
	httpapi.Accepted(w, map[string]any{"job": job.public()})
}

// runBackupJob executes a queued backup outside the request lifetime.
func (m *Module) runBackupJob(profile profileRecord, backup backupEntry, job jobEntry, password string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	m.startJob(job.ID, "正在执行备份")

	var (
		size int64
		err  error
	)
	switch profile.Kind {
	case kindPostgres:
		size, err = m.backupPostgres(ctx, profile, password, backup.Format, backup.Path)
	case kindRedis:
		size, err = m.backupRedis(ctx, profile, password, backup.Format, backup.Path)
	default:
		err = fmt.Errorf("不支持的数据库类型 %s", profile.Kind)
	}
	if err != nil {
		m.removeBackupFile(backup.Path)
		m.finishBackupRecord(backup.ID, backupFailed, 0, err.Error())
		m.finishJob(job.ID, jobFailed, "备份失败", err.Error())
		m.logWarn("数据库备份失败", "profileId", profile.ID, "backupId", backup.ID, "error", err.Error())
		return
	}
	m.finishBackupRecord(backup.ID, backupSuccess, size, "")
	m.finishJob(job.ID, jobSuccess, fmt.Sprintf("备份完成（%d 字节）", size), "")
	m.logInfo("数据库备份完成", "profileId", profile.ID, "backupId", backup.ID, "sizeBytes", size)
}

func (m *Module) removeBackupFile(path string) {
	if path == "" || !m.isWithinBackupDir(path) {
		return
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		m.logDebug("清理未完成的备份文件失败", "path", path, "error", err.Error())
	}
}

func (m *Module) handleBackupList(w http.ResponseWriter, r *http.Request) {
	profileID := r.PathValue("id")
	if _, ok := m.findProfile(profileID); !ok {
		httpapi.Fail(w, protocol.NotFound("数据库档案", profileID))
		return
	}
	entries := m.listBackups(profileID)
	views := make([]BackupRecord, 0, len(entries))
	for _, entry := range entries {
		views = append(views, entry.public())
	}
	httpapi.OK(w, pageResult(views, r))
}

func (m *Module) handleBackupGet(w http.ResponseWriter, r *http.Request) {
	entry, ok := m.findBackup(r.PathValue("backupId"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("备份", r.PathValue("backupId")))
		return
	}
	httpapi.OK(w, entry.public())
}

func (m *Module) handleBackupDelete(w http.ResponseWriter, r *http.Request) {
	if _, err := m.removeBackup(r.PathValue("backupId")); err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, map[string]any{"deleted": true})
}

func (m *Module) handleBackupDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("backupId")
	entry, ok := m.findBackup(id)
	if !ok {
		httpapi.Fail(w, protocol.NotFound("备份", id))
		return
	}
	if !m.isWithinBackupDir(entry.Path) {
		httpapi.Fail(w, protocol.NotFound("备份文件", id))
		return
	}
	file, err := os.Open(entry.Path)
	if err != nil {
		if os.IsNotExist(err) {
			httpapi.Fail(w, protocol.NotFound("备份文件", id))
			return
		}
		m.logWarn("打开备份文件失败", "backupId", id, "error", err.Error())
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeInternal, Message: "无法读取备份文件"})
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeInternal, Message: "无法读取备份文件"})
		return
	}
	name := downloadName(entry.FileName)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("X-MPanel-Api-Version", "1")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

// downloadName strips path separators and quotes so Content-Disposition cannot
// be broken or abused.
func downloadName(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	var builder strings.Builder
	for _, char := range name {
		if char == '"' || char == '\\' || char < 0x20 || char == 0x7f {
			builder.WriteRune('_')
			continue
		}
		builder.WriteRune(char)
	}
	result := builder.String()
	if result == "" || result == "." || result == ".." {
		return "backup.bin"
	}
	return result
}

func (m *Module) handleRestore(w http.ResponseWriter, r *http.Request) {
	record, ok := m.findProfile(r.PathValue("id"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("数据库档案", r.PathValue("id")))
		return
	}
	var input restoreRequest
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	if !input.Confirm {
		httpapi.Fail(w, protocol.BadRequest("恢复操作必须显式确认（confirm=true）"))
		return
	}
	backupID := strings.TrimSpace(input.BackupID)
	if backupID == "" {
		httpapi.Fail(w, protocol.BadRequest("backupId 不能为空"))
		return
	}
	entry, ok := m.findBackup(backupID)
	if !ok {
		httpapi.Fail(w, protocol.NotFound("备份", backupID))
		return
	}
	if entry.ProfileID != record.ID {
		httpapi.Fail(w, protocol.BadRequest("备份不属于该数据库档案"))
		return
	}
	if entry.Status != backupSuccess {
		httpapi.Fail(w, protocol.BadRequest("只能恢复状态为 success 的备份"))
		return
	}
	if !m.isWithinBackupDir(entry.Path) {
		httpapi.Fail(w, protocol.NotFound("备份文件", backupID))
		return
	}
	if _, err := os.Stat(entry.Path); err != nil {
		httpapi.Fail(w, protocol.NotFound("备份文件", backupID))
		return
	}

	switch record.Kind {
	case kindPostgres:
		var bin, label string
		switch entry.Format {
		case formatCustom:
			bin, label = m.pgRestoreBin(), "pg_restore"
		case formatPlain:
			bin, label = m.psqlBin(), "psql"
		default:
			httpapi.Fail(w, protocol.BadRequest("不支持的 PostgreSQL 备份格式"))
			return
		}
		if err := m.ensureTool(r.Context(), bin, label,
			"安装 PostgreSQL 客户端，或把 MPANEL_PG_DUMP_BIN/MPANEL_PSQL_BIN 指向对应可执行文件后重试。"); err != nil {
			httpapi.Fail(w, err)
			return
		}
	case kindRedis:
		if entry.Format == formatRDB {
			httpapi.Fail(w, &protocol.PanelError{
				Code:    protocol.CodeUnavailable,
				Message: "RDB 备份只能离线恢复",
				Hint:    "停止 Redis，把 .rdb 文件替换到 dir/dbfilename 后再启动；或改用 logical 格式做在线恢复。",
			})
			return
		}
		if entry.Format != formatLogical {
			httpapi.Fail(w, protocol.BadRequest("不支持的 Redis 备份格式"))
			return
		}
	default:
		httpapi.Fail(w, protocol.BadRequest("不支持的数据库类型"))
		return
	}

	password, err := m.passwordFor(record)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	job, err := m.beginRestore(record.ID, entry.ID)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	go m.runRestoreJob(record, entry, job, password)
	httpapi.Accepted(w, map[string]any{"job": job.public()})
}

// runRestoreJob executes a queued restore outside the request lifetime.
func (m *Module) runRestoreJob(profile profileRecord, backup backupEntry, job jobEntry, password string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	m.startJob(job.ID, "正在执行恢复")

	var err error
	switch profile.Kind {
	case kindPostgres:
		err = m.restorePostgres(ctx, profile, password, backup)
	case kindRedis:
		err = m.restoreRedis(ctx, profile, password, backup)
	default:
		err = fmt.Errorf("不支持的数据库类型 %s", profile.Kind)
	}
	if err != nil {
		m.finishJob(job.ID, jobFailed, "恢复失败", err.Error())
		m.logWarn("数据库恢复失败", "profileId", profile.ID, "backupId", backup.ID, "error", err.Error())
		return
	}
	m.finishJob(job.ID, jobSuccess, "恢复完成", "")
	m.logInfo("数据库恢复完成", "profileId", profile.ID, "backupId", backup.ID)
}

func (m *Module) handleJobList(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	jobs := m.listJobs(strings.TrimSpace(query.Get("profileId")), strings.TrimSpace(query.Get("status")))
	views := make([]DatabaseJob, 0, len(jobs))
	for _, job := range jobs {
		views = append(views, job.public())
	}
	httpapi.OK(w, pageResult(views, r))
}

func (m *Module) handleJobGet(w http.ResponseWriter, r *http.Request) {
	job, ok := m.findJob(r.PathValue("jobId"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("数据库作业", r.PathValue("jobId")))
		return
	}
	httpapi.OK(w, job.public())
}

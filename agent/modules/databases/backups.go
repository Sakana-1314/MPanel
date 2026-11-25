package databases

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/core/config"
	"github.com/sakana-1314/mpanel/core/protocol"
)

// maxJobs bounds the in-memory/persisted job history.
const maxJobs = 500

// backupEntry is the on-disk backup record. Path is internal and never leaves
// the agent.
type backupEntry struct {
	ID         string  `json:"id"`
	ProfileID  string  `json:"profileId"`
	Kind       string  `json:"kind"`
	Format     string  `json:"format"`
	Label      *string `json:"label,omitempty"`
	FileName   string  `json:"fileName"`
	SizeBytes  int64   `json:"sizeBytes"`
	Status     string  `json:"status"`
	CreatedAt  string  `json:"createdAt"`
	FinishedAt *string `json:"finishedAt,omitempty"`
	Error      *string `json:"error,omitempty"`
	Path       string  `json:"path,omitempty"`
}

func (b backupEntry) public() BackupRecord {
	return BackupRecord{
		ID:         b.ID,
		ProfileID:  b.ProfileID,
		Kind:       b.Kind,
		Format:     b.Format,
		Label:      b.Label,
		FileName:   b.FileName,
		SizeBytes:  b.SizeBytes,
		Status:     b.Status,
		CreatedAt:  b.CreatedAt,
		FinishedAt: b.FinishedAt,
		Error:      b.Error,
	}
}

// jobEntry is a DatabaseJob plus the internal creation order stamp.
type jobEntry struct {
	DatabaseJob
	CreatedAt string `json:"createdAt"`
}

func (j jobEntry) public() DatabaseJob { return j.DatabaseJob }

type backupsFile struct {
	Version int           `json:"version"`
	Backups []backupEntry `json:"backups"`
}

type jobsFile struct {
	Version int        `json:"version"`
	Jobs    []jobEntry `json:"jobs"`
}

func (m *Module) backupsPath() string {
	return filepath.Join(m.dataDir, "backups", "databases.json")
}

func (m *Module) jobsPath() string {
	return filepath.Join(m.dataDir, "backups", "jobs.json")
}

// backupDir is the only directory backups may be written to or downloaded
// from.
func (m *Module) backupDir() string {
	return filepath.Join(m.dataDir, "backups", "databases")
}

// loadBackups reads backups/databases.json.
func (m *Module) loadBackups() error {
	data, err := os.ReadFile(m.backupsPath())
	if err != nil {
		if os.IsNotExist(err) {
			m.backups = []backupEntry{}
			return nil
		}
		return fmt.Errorf("读取备份记录失败: %w", err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		m.backups = []backupEntry{}
		return nil
	}
	var file backupsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return fmt.Errorf("解析备份记录失败: %w", err)
	}
	if file.Backups == nil {
		file.Backups = []backupEntry{}
	}
	m.backups = file.Backups
	return nil
}

// loadJobs reads backups/jobs.json and marks jobs that were interrupted by an
// agent restart as failed, as the contract requires.
func (m *Module) loadJobs() error {
	m.jobs = map[string]*jobEntry{}
	m.jobOrder = []string{}
	data, err := os.ReadFile(m.jobsPath())
	if err != nil {
		if os.IsNotExist(err) {
			m.jobOrder = []string{}
			return nil
		}
		return fmt.Errorf("读取数据库作业失败: %w", err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		m.jobOrder = []string{}
		return nil
	}
	var file jobsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return fmt.Errorf("解析数据库作业失败: %w", err)
	}
	changed := false
	now := nowStamp()
	for i := range file.Jobs {
		job := file.Jobs[i]
		if job.Status == jobQueued || job.Status == jobRunning {
			job.Status = jobFailed
			job.Error = strPtr("agent 重启，作业已中断")
			job.FinishedAt = &now
			job.Progress = nil
			changed = true
		}
		if job.CreatedAt == "" {
			job.CreatedAt = now
			changed = true
		}
		copied := job
		m.jobs[job.ID] = &copied
		m.jobOrder = append(m.jobOrder, job.ID)
	}
	m.pruneJobsLocked()
	if changed {
		if err := m.saveJobsLocked(); err != nil {
			return err
		}
	}
	return nil
}

func (m *Module) saveBackupsLocked() error {
	file := backupsFile{Version: 1, Backups: m.backups}
	if file.Backups == nil {
		file.Backups = []backupEntry{}
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(m.backupsPath(), data, 0o600)
}

func (m *Module) saveJobsLocked() error {
	file := jobsFile{Version: 1, Jobs: make([]jobEntry, 0, len(m.jobOrder))}
	for _, id := range m.jobOrder {
		job, ok := m.jobs[id]
		if !ok {
			continue
		}
		file.Jobs = append(file.Jobs, *job)
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(m.jobsPath(), data, 0o600)
}

// newBackupPath builds <dataDir>/backups/databases/<profileId>-<backupId>-<ts>.<ext>.
func (m *Module) newBackupPath(profileID, backupID, extension string) string {
	stamp := time.Now().UTC().Format("20060102-150405")
	name := fmt.Sprintf("%s-%s-%s.%s", profileID, backupID, stamp, extension)
	return filepath.Join(m.backupDir(), name)
}

// isWithinBackupDir guards reads and removes against path traversal and symlink
// escapes. It resolves symlinks when the target exists.
func (m *Module) isWithinBackupDir(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	root, err := filepath.Abs(m.backupDir())
	if err != nil {
		return false
	}
	target, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	if resolvedRoot, err := filepath.EvalSymlinks(root); err == nil {
		root = resolvedRoot
	}
	if resolvedTarget, err := filepath.EvalSymlinks(target); err == nil {
		target = resolvedTarget
	}
	rel, err := filepath.Rel(root, target)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && rel != "."
}

// reconcileInterruptedBackups marks records left "running" by an agent restart
// as failed, matching the job reconciliation performed by loadJobs.
func (m *Module) reconcileInterruptedBackups() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	changed := false
	finished := nowStamp()
	for i := range m.backups {
		if m.backups[i].Status != backupRunning {
			continue
		}
		m.backups[i].Status = backupFailed
		m.backups[i].FinishedAt = &finished
		m.backups[i].Error = strPtr("agent 重启，备份已中断")
		changed = true
	}
	if !changed {
		return nil
	}
	return m.saveBackupsLocked()
}

// updateBackup applies a mutation and persists it. Errors are logged because
// the job has already finished by the time this runs.
func (m *Module) updateBackup(id string, mutate func(*backupEntry)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.backups {
		if m.backups[i].ID != id {
			continue
		}
		mutate(&m.backups[i])
		if err := m.saveBackupsLocked(); err != nil {
			m.logWarn("保存备份记录失败", "backupId", id, "error", err.Error())
		}
		return
	}
}

func (m *Module) findBackup(id string) (backupEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, entry := range m.backups {
		if entry.ID == id {
			return entry, true
		}
	}
	return backupEntry{}, false
}

func (m *Module) listBackups(profileID string) []backupEntry {
	m.mu.Lock()
	entries := make([]backupEntry, 0, len(m.backups))
	for _, entry := range m.backups {
		if entry.ProfileID == profileID {
			entries = append(entries, entry)
		}
	}
	m.mu.Unlock()
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].CreatedAt == entries[j].CreatedAt {
			return entries[i].ID > entries[j].ID
		}
		return entries[i].CreatedAt > entries[j].CreatedAt
	})
	return entries
}

// removeBackup deletes the record and the file. Running backups are protected
// by the handler (CONFLICT).
func (m *Module) removeBackup(id string) (backupEntry, error) {
	m.mu.Lock()
	index := -1
	for i := range m.backups {
		if m.backups[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		m.mu.Unlock()
		return backupEntry{}, protocol.NotFound("备份", id)
	}
	if m.backups[index].Status == backupRunning {
		m.mu.Unlock()
		return backupEntry{}, &protocol.PanelError{
			Code:    protocol.CodeConflict,
			Message: "备份正在执行，无法删除",
			Details: map[string]any{"resource": "backup", "id": id},
		}
	}
	removed := m.backups[index]
	m.backups = append(m.backups[:index], m.backups[index+1:]...)
	if err := m.saveBackupsLocked(); err != nil {
		m.backups = append(m.backups, backupEntry{})
		copy(m.backups[index+1:], m.backups[index:])
		m.backups[index] = removed
		m.mu.Unlock()
		return backupEntry{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "保存备份记录失败"}
	}
	m.mu.Unlock()
	if removed.Path != "" && m.isWithinBackupDir(removed.Path) {
		if err := os.Remove(removed.Path); err != nil && !os.IsNotExist(err) {
			m.logWarn("删除备份文件失败", "backupId", id, "error", err.Error())
		}
	}
	return removed, nil
}

// activeJobForProfileLocked reports the id of a queued/running job.
func (m *Module) activeJobForProfileLocked(profileID string) string {
	for _, job := range m.jobs {
		if job.ProfileID == profileID && (job.Status == jobQueued || job.Status == jobRunning) {
			return job.ID
		}
	}
	return ""
}

// beginBackup atomically registers a running backup record and a queued job.
func (m *Module) beginBackup(profile profileRecord, format string, label *string) (backupEntry, jobEntry, error) {
	now := nowStamp()
	backupID := "bk_" + protocol.RandomID(9)
	extension := "dump"
	switch {
	case profile.Kind == kindPostgres && format == formatPlain:
		extension = "sql"
	case profile.Kind == kindRedis && format == formatRDB:
		extension = "rdb"
	case profile.Kind == kindRedis:
		extension = "logical"
	}
	path := m.newBackupPath(profile.ID, backupID, extension)
	var labelCopy *string
	if label != nil {
		trimmed := strings.TrimSpace(*label)
		if trimmed != "" {
			if len([]rune(trimmed)) > 128 {
				return backupEntry{}, jobEntry{}, protocol.BadRequest("label 不能超过 128 个字符")
			}
			labelCopy = &trimmed
		}
	}
	backup := backupEntry{
		ID:        backupID,
		ProfileID: profile.ID,
		Kind:      profile.Kind,
		Format:    format,
		Label:     labelCopy,
		FileName:  filepath.Base(path),
		Status:    backupRunning,
		CreatedAt: now,
		Path:      path,
	}
	job := jobEntry{
		DatabaseJob: DatabaseJob{
			ID:        "job_" + protocol.RandomID(9),
			ProfileID: profile.ID,
			Type:      jobTypeBackup,
			Status:    jobQueued,
			BackupID:  &backupID,
		},
		CreatedAt: now,
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if active := m.activeJobForProfileLocked(profile.ID); active != "" {
		return backupEntry{}, jobEntry{}, &protocol.PanelError{
			Code:    protocol.CodeConflict,
			Message: "该档案已有运行中的作业",
			Details: map[string]any{"resource": "databaseJob", "id": active},
		}
	}
	m.backups = append(m.backups, backup)
	m.jobs[job.ID] = &job
	m.jobOrder = append(m.jobOrder, job.ID)
	m.pruneJobsLocked()
	if err := m.saveBackupsLocked(); err != nil {
		m.backups = m.backups[:len(m.backups)-1]
		delete(m.jobs, job.ID)
		m.jobOrder = m.jobOrder[:len(m.jobOrder)-1]
		return backupEntry{}, jobEntry{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "保存备份记录失败"}
	}
	if err := m.saveJobsLocked(); err != nil {
		m.backups = m.backups[:len(m.backups)-1]
		delete(m.jobs, job.ID)
		m.jobOrder = m.jobOrder[:len(m.jobOrder)-1]
		return backupEntry{}, jobEntry{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "保存作业失败"}
	}
	return backup, job, nil
}

// beginRestore registers a queued restore job.
func (m *Module) beginRestore(profileID, backupID string) (jobEntry, error) {
	now := nowStamp()
	job := jobEntry{
		DatabaseJob: DatabaseJob{
			ID:        "job_" + protocol.RandomID(9),
			ProfileID: profileID,
			Type:      jobTypeRestore,
			Status:    jobQueued,
			BackupID:  &backupID,
		},
		CreatedAt: now,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if active := m.activeJobForProfileLocked(profileID); active != "" {
		return jobEntry{}, &protocol.PanelError{
			Code:    protocol.CodeConflict,
			Message: "该档案已有运行中的作业",
			Details: map[string]any{"resource": "databaseJob", "id": active},
		}
	}
	m.jobs[job.ID] = &job
	m.jobOrder = append(m.jobOrder, job.ID)
	m.pruneJobsLocked()
	if err := m.saveJobsLocked(); err != nil {
		delete(m.jobs, job.ID)
		m.jobOrder = m.jobOrder[:len(m.jobOrder)-1]
		return jobEntry{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "保存作业失败"}
	}
	return job, nil
}

// pruneJobsLocked keeps the newest maxJobs entries; running jobs are never
// evicted.
func (m *Module) pruneJobsLocked() {
	for len(m.jobOrder) > maxJobs {
		removed := false
		for index, id := range m.jobOrder {
			job, ok := m.jobs[id]
			if ok && (job.Status == jobQueued || job.Status == jobRunning) {
				continue
			}
			delete(m.jobs, id)
			m.jobOrder = append(m.jobOrder[:index], m.jobOrder[index+1:]...)
			removed = true
			break
		}
		if !removed {
			return
		}
	}
}

// updateJob mutates and persists a job. Persistence failures are logged: the
// in-memory state is still authoritative for the current process.
func (m *Module) updateJob(id string, mutate func(*jobEntry)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[id]
	if !ok {
		return
	}
	mutate(job)
	if err := m.saveJobsLocked(); err != nil {
		m.logWarn("保存数据库作业失败", "jobId", id, "error", err.Error())
	}
}

func (m *Module) findJob(id string) (jobEntry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[id]
	if !ok {
		return jobEntry{}, false
	}
	return *job, true
}

// listJobs returns newest-first jobs filtered by profile and status.
func (m *Module) listJobs(profileID, status string) []jobEntry {
	m.mu.Lock()
	jobs := make([]jobEntry, 0, len(m.jobs))
	for _, job := range m.jobs {
		if profileID != "" && job.ProfileID != profileID {
			continue
		}
		if status != "" && job.Status != status {
			continue
		}
		jobs = append(jobs, *job)
	}
	m.mu.Unlock()
	sort.SliceStable(jobs, func(i, j int) bool {
		if jobs[i].CreatedAt == jobs[j].CreatedAt {
			return jobs[i].ID > jobs[j].ID
		}
		return jobs[i].CreatedAt > jobs[j].CreatedAt
	})
	return jobs
}

// finishBackupRecord records the terminal state of a backup.
func (m *Module) finishBackupRecord(id, status string, size int64, errMsg string) {
	finished := nowStamp()
	m.updateBackup(id, func(entry *backupEntry) {
		entry.Status = status
		entry.FinishedAt = &finished
		if status == backupSuccess {
			entry.SizeBytes = size
			entry.Error = nil
		} else if errMsg != "" {
			safe := truncateText(errMsg, 500)
			entry.Error = &safe
		}
	})
}

// finishJob records the terminal state of a job.
func (m *Module) finishJob(id, status, progress, errMsg string) {
	finished := nowStamp()
	m.updateJob(id, func(job *jobEntry) {
		job.Status = status
		job.FinishedAt = &finished
		if progress != "" {
			p := truncateText(progress, 200)
			job.Progress = &p
		}
		if errMsg != "" {
			safe := truncateText(errMsg, 500)
			job.Error = &safe
		}
	})
}

// startJob transitions a queued job to running.
func (m *Module) startJob(id, progress string) {
	started := nowStamp()
	m.updateJob(id, func(job *jobEntry) {
		job.Status = jobRunning
		job.StartedAt = &started
		if progress != "" {
			p := truncateText(progress, 200)
			job.Progress = &p
		}
	})
}

// copyFile copies src to dst (0640) and returns the byte count.
func copyFile(dst, src string) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, err
	}
	source, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer source.Close()
	target, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(target, source)
	syncErr := target.Sync()
	closeErr := target.Close()
	switch {
	case copyErr != nil:
		return written, copyErr
	case syncErr != nil:
		return written, syncErr
	default:
		return written, closeErr
	}
}

// truncateText makes an error string safe for a JSON error field.
func truncateText(value string, limit int) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\r", ""))
	if index := strings.IndexByte(value, '\n'); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	if len(value) > limit {
		value = value[:limit]
	}
	return value
}

// fileSize returns the size of path or an error.
func fileSize(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

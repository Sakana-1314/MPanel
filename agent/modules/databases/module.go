package databases

import (
	"log/slog"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/internal/auth"
	"github.com/sakana-1314/mpanel/internal/config"
)

// Module implements the database profile, statistics, handoff and
// backup/restore endpoints of API contract §8.
type Module struct {
	mu      sync.Mutex
	dataDir string
	logger  *slog.Logger
	runner  agent.Runner
	cfg     *config.Agent

	profiles []profileRecord
	backups  []backupEntry
	jobs     map[string]*jobEntry
	jobOrder []string
	key      []byte

	tickets       *handoffStore
	redeemLimiter *auth.LoginLimiter
	dbxOrigins    map[string]struct{}
	dbxAllowAny   bool
}

// New returns an unregistered databases module. The environment (data dir,
// runner, limits) is bound in Register.
func New() *Module {
	return &Module{
		jobs:       map[string]*jobEntry{},
		jobOrder:   []string{},
		tickets:    newHandoffStore(),
		dbxOrigins: map[string]struct{}{},
	}
}

// Name implements agent.Module.
func (m *Module) Name() string { return "databases" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	m.mu.Lock()
	m.dataDir = ctx.DataDir()
	m.logger = ctx.Logger
	m.runner = ctx.Runner
	m.cfg = ctx.Cfg
	m.mu.Unlock()
	if m.logger == nil {
		m.logger = slog.Default()
	}

	if err := m.loadProfiles(); err != nil {
		return err
	}
	if err := m.loadBackups(); err != nil {
		return err
	}
	if err := m.loadJobs(); err != nil {
		return err
	}
	if err := m.reconcileInterruptedBackups(); err != nil {
		return err
	}
	// Create secrets.key on first start so backups of the data directory always
	// include the key, even before the first password is stored.
	m.mu.Lock()
	_, keyErr := m.encryptionKeyLocked()
	m.mu.Unlock()
	if keyErr != nil {
		return keyErr
	}
	m.redeemLimiter = auth.NewLoginLimiter(parseRedeemLimit(), time.Minute)
	m.dbxOrigins, m.dbxAllowAny = parseDBXOrigins()

	mux := ctx.Mux
	mux.HandleFunc("GET /api/v1/databases/profiles", m.handleProfileList)
	mux.HandleFunc("POST /api/v1/databases/profiles", m.handleProfileCreate)
	mux.HandleFunc("GET /api/v1/databases/profiles/{id}", m.handleProfileGet)
	mux.HandleFunc("PATCH /api/v1/databases/profiles/{id}", m.handleProfilePatch)
	mux.HandleFunc("DELETE /api/v1/databases/profiles/{id}", m.handleProfileDelete)
	mux.HandleFunc("POST /api/v1/databases/profiles/{id}/test", m.handleProfileTest)
	mux.HandleFunc("GET /api/v1/databases/profiles/{id}/stats", m.handleProfileStats)
	mux.HandleFunc("POST /api/v1/databases/profiles/{id}/handoff", m.handleHandoff)
	mux.HandleFunc("POST /api/v1/databases/handoff/redeem", m.handleRedeem)
	mux.HandleFunc("POST /api/v1/databases/profiles/{id}/backup", m.handleBackupCreate)
	mux.HandleFunc("GET /api/v1/databases/profiles/{id}/backups", m.handleBackupList)
	mux.HandleFunc("POST /api/v1/databases/profiles/{id}/restore", m.handleRestore)
	mux.HandleFunc("GET /api/v1/databases/backups/{backupId}", m.handleBackupGet)
	mux.HandleFunc("DELETE /api/v1/databases/backups/{backupId}", m.handleBackupDelete)
	mux.HandleFunc("GET /api/v1/databases/backups/{backupId}/download", m.handleBackupDownload)
	mux.HandleFunc("GET /api/v1/databases/jobs", m.handleJobList)
	mux.HandleFunc("GET /api/v1/databases/jobs/{jobId}", m.handleJobGet)
	return nil
}

func (m *Module) logWarn(message string, args ...any) {
	logger := m.logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Warn(message, args...)
}

func (m *Module) logInfo(message string, args ...any) {
	logger := m.logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info(message, args...)
}

// logDebug is used for cleanup paths that must never surface as errors.
func (m *Module) logDebug(message string, args ...any) {
	logger := m.logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Debug(message, args...)
}

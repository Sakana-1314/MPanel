// Package databases implements database profiles, connectivity tests, live
// statistics, dbx handoff tickets and backup/restore jobs (API contract §8).
package databases

import (
	"encoding/json"
	"time"
)

// Database kinds (contract §8.1).
const (
	kindPostgres = "postgres"
	kindRedis    = "redis"
)

// Backup formats (contract §8.5).
const (
	formatCustom  = "custom"
	formatPlain   = "plain"
	formatLogical = "logical"
	formatRDB     = "rdb"
)

// Backup record states.
const (
	backupRunning = "running"
	backupSuccess = "success"
	backupFailed  = "failed"
)

// Job states (contract §8.5).
const (
	jobQueued  = "queued"
	jobRunning = "running"
	jobSuccess = "success"
	jobFailed  = "failed"
)

// Job types.
const (
	jobTypeBackup  = "backup"
	jobTypeRestore = "restore"
)

// handoffRedeemURL is fixed by the contract and resolved against the caller's
// API feature base path.
const handoffRedeemURL = "/databases/handoff/redeem"

// stampLayout matches the contract timestamp example (UTC, milliseconds, Z).
const stampLayout = "2006-01-02T15:04:05.000Z"

func nowStamp() string { return time.Now().UTC().Format(stampLayout) }

func stampAt(t time.Time) string { return t.UTC().Format(stampLayout) }

// DatabaseProfile is the public profile shape. It never carries the password.
type DatabaseProfile struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Kind        string     `json:"kind"`
	Host        string     `json:"host"`
	Port        int        `json:"port"`
	Username    *string    `json:"username"`
	Database    *string    `json:"database"`
	TLS         bool       `json:"tls"`
	RedisDB     *int       `json:"redisDb"`
	HasPassword bool       `json:"hasPassword"`
	LastCheck   *lastCheck `json:"lastCheck"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
}

// lastCheck is the most recent connectivity probe stored on the profile.
type lastCheck struct {
	At            string `json:"at"`
	OK            bool   `json:"ok"`
	LatencyMs     int64  `json:"latencyMs"`
	ServerVersion string `json:"serverVersion,omitempty"`
	Message       string `json:"message,omitempty"`
}

// DatabaseProfileCreateInput is the decoded POST body. Pointer fields let the
// handler distinguish "omitted" (use the default) from an explicit value.
type DatabaseProfileCreateInput struct {
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Host     string  `json:"host"`
	Port     *int    `json:"port"`
	Username *string `json:"username"`
	Password *string `json:"password"`
	Database *string `json:"database"`
	TLS      *bool   `json:"tls"`
	RedisDB  *int    `json:"redisDb"`
}

// nilable distinguishes "absent" from an explicit JSON null.
type nilable[T any] struct {
	Set   bool
	Value *T
}

// UnmarshalJSON records presence, mapping null to a nil value.
func (n *nilable[T]) UnmarshalJSON(data []byte) error {
	n.Set = true
	if string(data) == "null" {
		n.Value = nil
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	n.Value = &value
	return nil
}

// DatabaseProfileUpdateInput is the decoded PATCH body (contract §8.2).
// Kind is intentionally absent: it cannot change after creation.
type DatabaseProfileUpdateInput struct {
	Name     *string         `json:"name"`
	Host     *string         `json:"host"`
	Port     *int            `json:"port"`
	Username nilable[string] `json:"username"`
	Password nilable[string] `json:"password"`
	Database nilable[string] `json:"database"`
	TLS      *bool           `json:"tls"`
	RedisDB  nilable[int]    `json:"redisDb"`
}

// DatabaseTestResult is the response of POST .../test.
type DatabaseTestResult struct {
	OK            bool   `json:"ok"`
	LatencyMs     int64  `json:"latencyMs"`
	ServerVersion string `json:"serverVersion,omitempty"`
	Message       string `json:"message,omitempty"`
}

// PostgresStats mirrors contract §8.3. LongestTransactionSec is additive: the
// contract has no field for it but operators need the value.
type PostgresStats struct {
	Kind                  string        `json:"kind"`
	Version               string        `json:"version"`
	UptimeSec             int64         `json:"uptimeSec"`
	Connections           pgConnections `json:"connections"`
	DatabaseSizeBytes     int64         `json:"databaseSizeBytes"`
	CacheHitRatio         *float64      `json:"cacheHitRatio"`
	TransactionsPerSec    *float64      `json:"transactionsPerSec"`
	LongestTransactionSec float64       `json:"longestTransactionSec"`
}

// pgConnections is the connection breakdown.
type pgConnections struct {
	Total             int64 `json:"total"`
	Active            int64 `json:"active"`
	Idle              int64 `json:"idle"`
	IdleInTransaction int64 `json:"idleInTransaction"`
}

// RedisStats mirrors contract §8.3. CacheHitRatio, TotalKeys and Slowlog are
// additive fields the contract does not model; slowlog is sanitised to command
// names only (never arguments, which may contain secrets).
type RedisStats struct {
	Kind             string               `json:"kind"`
	Version          string               `json:"version"`
	UptimeSec        int64                `json:"uptimeSec"`
	Role             string               `json:"role"`
	ConnectedClients int64                `json:"connectedClients"`
	UsedMemoryBytes  int64                `json:"usedMemoryBytes"`
	MaxMemoryBytes   *int64               `json:"maxMemoryBytes"`
	OpsPerSec        *int64               `json:"opsPerSec"`
	CacheHitRatio    *float64             `json:"cacheHitRatio,omitempty"`
	TotalKeys        int64                `json:"totalKeys"`
	Keyspace         []redisKeyspaceEntry `json:"keyspace"`
	Slowlog          []redisSlowlogEntry  `json:"slowlog,omitempty"`
}

// redisKeyspaceEntry is one "dbN" line of INFO keyspace.
type redisKeyspaceEntry struct {
	DB      int   `json:"db"`
	Keys    int64 `json:"keys"`
	Expires int64 `json:"expires"`
}

// redisSlowlogEntry drops command arguments so passwords cannot leak.
type redisSlowlogEntry struct {
	ID         int64  `json:"id"`
	At         string `json:"at"`
	DurationMs int64  `json:"durationMs"`
	Command    string `json:"command"`
}

// HandoffTicket is the response of POST .../handoff.
type HandoffTicket struct {
	Ticket    string `json:"ticket"`
	ExpiresAt string `json:"expiresAt"`
	RedeemURL string `json:"redeemUrl"`
	Kind      string `json:"kind"`
}

// HandoffPayload is the response of POST /databases/handoff/redeem. It is the
// only endpoint that returns the decrypted password.
type HandoffPayload struct {
	ProfileID        string  `json:"profileId"`
	Name             string  `json:"name"`
	Kind             string  `json:"kind"`
	Host             string  `json:"host"`
	Port             int     `json:"port"`
	Username         *string `json:"username"`
	Password         *string `json:"password"`
	Database         *string `json:"database"`
	TLS              bool    `json:"tls"`
	RedisDB          *int    `json:"redisDb"`
	ConnectionString string  `json:"connectionString,omitempty"`
}

// BackupRecord is the public backup shape (contract §8.5). The on-disk path is
// internal and never serialised.
type BackupRecord struct {
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
}

// DatabaseJob is the public asynchronous job shape.
type DatabaseJob struct {
	ID         string  `json:"id"`
	ProfileID  string  `json:"profileId"`
	Type       string  `json:"type"`
	Status     string  `json:"status"`
	BackupID   *string `json:"backupId,omitempty"`
	StartedAt  *string `json:"startedAt,omitempty"`
	FinishedAt *string `json:"finishedAt,omitempty"`
	Progress   *string `json:"progress,omitempty"`
	Error      *string `json:"error,omitempty"`
}

// backupRequest is the decoded POST .../backup body.
type backupRequest struct {
	Format string  `json:"format"`
	Label  *string `json:"label"`
}

// restoreRequest is the decoded POST .../restore body.
type restoreRequest struct {
	BackupID string `json:"backupId"`
	Confirm  bool   `json:"confirm"`
}

// handoffRequest is the decoded POST .../handoff body.
type handoffRequest struct {
	TTLSec *int `json:"ttlSec"`
}

// redeemRequest is the decoded POST /databases/handoff/redeem body.
type redeemRequest struct {
	Ticket string `json:"ticket"`
}

// revealedProfile is returned by GET .../profiles/{id}?reveal=1. It is the
// only non-handoff response that carries the plaintext password.
type revealedProfile struct {
	DatabaseProfile
	Password *string `json:"password,omitempty"`
}

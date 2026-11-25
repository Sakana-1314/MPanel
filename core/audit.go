package core

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/core/protocol"
	"github.com/sakana-1314/mpanel/core/store"
)

// AuditEntry is one append-only audit line.
type AuditEntry struct {
	At      string         `json:"at"`
	Action  string         `json:"action"`
	Target  string         `json:"target"`
	Result  string         `json:"result"`
	Details map[string]any `json:"details,omitempty"`
}

// AuditLog appends JSON lines to db/audit.jsonl.
type AuditLog struct {
	mu   sync.Mutex
	path string
	file *os.File
}

// NewAuditLog opens (or creates) the audit file with 0600.
func NewAuditLog(path string) (*AuditLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &AuditLog{path: path, file: file}, nil
}

// Write appends one entry; failures are swallowed on purpose (audit must never
// break a request), but the file handle is kept open for the process lifetime.
func (a *AuditLog) Write(action, target, result string, details map[string]any) {
	if a == nil || a.file == nil {
		return
	}
	entry := AuditEntry{At: store.Now(), Action: action, Target: target, Result: result, Details: details}
	data, err := json.Marshal(entry)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = a.file.Write(append(data, '\n'))
}

// Query returns audit entries newest first with offset pagination.
func (a *AuditLog) Query(limitRaw, cursor string) (protocol.ListResult[AuditEntry], error) {
	limit := 50
	if parsed, err := strconv.Atoi(limitRaw); err == nil && parsed > 0 {
		limit = parsed
	}
	if limit > 200 {
		limit = 200
	}
	offset := 0
	if parsed, err := strconv.Atoi(cursor); err == nil && parsed > 0 {
		offset = parsed
	}
	file, err := os.Open(a.path)
	if err != nil {
		if os.IsNotExist(err) {
			return protocol.NewList([]AuditEntry{}), nil
		}
		return protocol.ListResult[AuditEntry]{}, err
	}
	defer file.Close()
	var entries []AuditEntry
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry AuditEntry
		if json.Unmarshal([]byte(line), &entry) == nil {
			entries = append(entries, entry)
		}
	}
	// newest first
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	if offset > len(entries) {
		offset = len(entries)
	}
	end := offset + limit
	if end > len(entries) {
		end = len(entries)
	}
	page := append([]AuditEntry{}, entries[offset:end]...)
	total := len(entries)
	result := protocol.ListResult[AuditEntry]{Available: true, Items: page, Total: &total}
	if end < len(entries) {
		result.NextCursor = strconv.Itoa(end)
	}
	return result, nil
}

// Close flushes and closes the audit file.
func (a *AuditLog) Close() error {
	if a == nil || a.file == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_ = a.file.Sync()
	return a.file.Close()
}

var _ = time.Now

// Package store provides small persistent JSON documents with atomic writes.
// MPanel deliberately avoids a database dependency for the control plane: the
// state is bounded, human-inspectable, and easy to back up (1Panel keeps a
// sqlite file under /opt/mpanel/db; we keep JSON under the same tree).
package store

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
)

// Store is a typed JSON document guarded by a mutex.
type Store[T any] struct {
	mu    sync.Mutex
	path  string
	empty func() T
}

// Open creates a store at path. empty returns the zero document when the file
// does not exist yet.
func Open[T any](path string, empty func() T) *Store[T] {
	return &Store[T]{path: path, empty: empty}
}

// Path returns the backing file path.
func (s *Store[T]) Path() string { return s.path }

// Read returns a copy of the document. The callback must treat it as read-only
// unless it mutates through Update.
func (s *Store[T]) Read() (T, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *Store[T]) readLocked() (T, error) {
	var doc T
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s.empty(), nil
		}
		return doc, err
	}
	if len(data) == 0 {
		return s.empty(), nil
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return doc, err
	}
	return doc, nil
}

// Update applies fn to the document under the lock and persists the result.
func (s *Store[T]) Update(fn func(*T) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.readLocked()
	if err != nil {
		return err
	}
	if err := fn(&doc); err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(s.path, append(data, '\n'), 0o600)
}

// Write replaces the whole document.
func (s *Store[T]) Write(doc T) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(s.path, append(data, '\n'), 0o600)
}

// NewID returns a prefixed URL-safe identifier.
func NewID(prefix string) string {
	buf := make([]byte, 9)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buf)
}

// Now returns the current time as an RFC3339 UTC string, the wire format used
// by the API contract.
func Now() string { return time.Now().UTC().Format(time.RFC3339) }

// NowNano returns RFC3339 with nanoseconds for ordering inside one second.
func NowNano() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// EnsureDir creates dir with 0700 when missing.
func EnsureDir(dir string) error { return os.MkdirAll(dir, 0o700) }

// HomePath joins parts to the base dir.
func HomePath(base string, parts ...string) string {
	all := append([]string{base}, parts...)
	return filepath.Join(all...)
}

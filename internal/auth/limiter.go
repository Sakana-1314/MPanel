package auth

import (
	"sync"
	"time"
)

// LoginLimiter is a sliding-window counter per key (IP). Successful logins do
// not clear the bucket: every attempt counts (notes/go-design.md §2.3 fixes the
// old implementation's bug).
type LoginLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
	now    func() time.Time
}

// NewLoginLimiter creates a limiter allowing limit attempts per window.
func NewLoginLimiter(limit int, window time.Duration) *LoginLimiter {
	if limit <= 0 {
		limit = 5
	}
	if window <= 0 {
		window = time.Minute
	}
	return &LoginLimiter{limit: limit, window: window, hits: map[string][]time.Time{}, now: time.Now}
}

// Hit records an attempt for key. allowed is false once the window is full;
// retryAfterSec then reports when the oldest attempt expires.
func (l *LoginLimiter) Hit(key string) (allowed bool, retryAfterSec int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-l.window)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.hits[key] = kept
	if len(kept) >= l.limit {
		wait := kept[0].Add(l.window).Sub(now)
		sec := int(wait.Seconds() + 0.999)
		if sec < 1 {
			sec = 1
		}
		return false, sec
	}
	l.hits[key] = append(kept, now)
	return true, 0
}

// Reset drops the bucket for key (tests / explicit admin reset only).
func (l *LoginLimiter) Reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}

// Cleanup removes empty buckets; called opportunistically.
func (l *LoginLimiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now().Add(-l.window)
	for k, list := range l.hits {
		kept := list[:0]
		for _, t := range list {
			if t.After(cutoff) {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(l.hits, k)
		} else {
			l.hits[k] = kept
		}
	}
}

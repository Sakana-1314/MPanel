package agent

import (
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/core/protocol"
)

// ticketStore holds one-shot WebSocket tickets for direct browser connections.
type ticketStore struct {
	mu    sync.Mutex
	items map[string]ticketEntry
}

type ticketEntry struct {
	purpose string
	expires time.Time
}

func newTicketStore() *ticketStore { return &ticketStore{items: map[string]ticketEntry{}} }

func (t *ticketStore) issue(purpose string) (string, string) {
	ticket := protocol.RandomID(24)
	expires := time.Now().Add(60 * time.Second)
	t.mu.Lock()
	for key, entry := range t.items {
		if time.Now().After(entry.expires) {
			delete(t.items, key)
		}
	}
	t.items[ticket] = ticketEntry{purpose: purpose, expires: expires}
	t.mu.Unlock()
	return "wst_" + ticket, expires.UTC().Format(time.RFC3339)
}

func (t *ticketStore) redeem(ticket string) bool {
	if ticket == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.items[ticket]
	if !ok {
		return false
	}
	delete(t.items, ticket)
	return time.Now().Before(entry.expires)
}

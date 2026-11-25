package auth

import (
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/core/protocol"
)

// SessionRecord is one persisted browser session.
type SessionRecord struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	Role       string `json:"role"`
	CreatedAt  string `json:"createdAt"`
	ExpiresAt  string `json:"expiresAt"`
	LastSeenAt string `json:"lastSeenAt"`
}

type sessionDoc struct {
	Sessions map[string]SessionRecord `json:"sessions"`
}

// TokenRecord is one persisted API token (only the SHA-256 is stored).
type TokenRecord struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Hash       string  `json:"hash"`
	Scope      string  `json:"scope"`
	CreatedAt  string  `json:"createdAt"`
	ExpiresAt  *string `json:"expiresAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	RevokedAt  *string `json:"revokedAt"`
}

// TokenView is the client-facing token shape (no hash).
type TokenView struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Scope      string  `json:"scope"`
	CreatedAt  string  `json:"createdAt"`
	ExpiresAt  *string `json:"expiresAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	RevokedAt  *string `json:"revokedAt"`
}

func (t TokenRecord) View() TokenView {
	return TokenView{ID: t.ID, Name: t.Name, Scope: t.Scope, CreatedAt: t.CreatedAt,
		ExpiresAt: t.ExpiresAt, LastUsedAt: t.LastUsedAt, RevokedAt: t.RevokedAt}
}

type tokenDoc struct {
	Tokens map[string]TokenRecord `json:"tokens"`
}

// CreateSession persists a new session valid for SessionTTL.
func (s *Service) CreateSession() (SessionRecord, error) {
	now := s.now().UTC()
	rec := SessionRecord{
		ID:         NewSecret("sess_", 32),
		Username:   s.Username(),
		Role:       "admin",
		CreatedAt:  now.Format(time.RFC3339),
		ExpiresAt:  now.Add(SessionTTL).Format(time.RFC3339),
		LastSeenAt: now.Format(time.RFC3339),
	}
	err := s.sessions.Update(func(doc *sessionDoc) error {
		if doc.Sessions == nil {
			doc.Sessions = map[string]SessionRecord{}
		}
		// Opportunistically drop expired sessions.
		for id, item := range doc.Sessions {
			if expired(item.ExpiresAt, now) {
				delete(doc.Sessions, id)
			}
		}
		doc.Sessions[rec.ID] = rec
		return nil
	})
	return rec, err
}

// Session returns a live session by id.
func (s *Service) Session(id string) (SessionRecord, bool) {
	if id == "" {
		return SessionRecord{}, false
	}
	doc, err := s.sessions.Read()
	if err != nil {
		return SessionRecord{}, false
	}
	rec, ok := doc.Sessions[id]
	if !ok || expired(rec.ExpiresAt, s.now().UTC()) {
		return SessionRecord{}, false
	}
	return rec, true
}

// TouchSession extends an active session (sliding expiration).
func (s *Service) TouchSession(id string) (SessionRecord, bool) {
	var out SessionRecord
	found := false
	now := s.now().UTC()
	err := s.sessions.Update(func(doc *sessionDoc) error {
		rec, ok := doc.Sessions[id]
		if !ok || expired(rec.ExpiresAt, now) {
			delete(doc.Sessions, id)
			return nil
		}
		rec.ExpiresAt = now.Add(SessionTTL).Format(time.RFC3339)
		rec.LastSeenAt = now.Format(time.RFC3339)
		doc.Sessions[id] = rec
		out = rec
		found = true
		return nil
	})
	if err != nil {
		return SessionRecord{}, false
	}
	return out, found
}

// DeleteSession removes one session.
func (s *Service) DeleteSession(id string) error {
	return s.sessions.Update(func(doc *sessionDoc) error {
		delete(doc.Sessions, id)
		return nil
	})
}

// DeleteOtherSessions removes every session except keepID.
func (s *Service) DeleteOtherSessions(keepID string) error {
	return s.sessions.Update(func(doc *sessionDoc) error {
		for id := range doc.Sessions {
			if id != keepID {
				delete(doc.Sessions, id)
			}
		}
		return nil
	})
}

// CreateToken issues an API token; the plaintext is returned exactly once.
func (s *Service) CreateToken(name, scope string, ttl time.Duration) (TokenView, string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 64 {
		return TokenView{}, "", protocol.BadRequest("token 名称必填且不超过 64 个字符")
	}
	if scope != "read" && scope != "write" {
		return TokenView{}, "", protocol.BadRequest("token scope 只能是 read 或 write")
	}
	secret := NewSecret(APITokenPrefix, 32)
	now := s.now().UTC()
	rec := TokenRecord{
		ID:        NewSecret("tok_", 12),
		Name:      name,
		Hash:      SHA256Hex(secret),
		Scope:     scope,
		CreatedAt: now.Format(time.RFC3339),
	}
	if ttl > 0 {
		rec.ExpiresAt = protocol.StrPtr(now.Add(ttl).Format(time.RFC3339))
	}
	err := s.tokens.Update(func(doc *tokenDoc) error {
		if doc.Tokens == nil {
			doc.Tokens = map[string]TokenRecord{}
		}
		doc.Tokens[rec.ID] = rec
		return nil
	})
	return rec.View(), secret, err
}

// ListTokens returns all tokens newest first.
func (s *Service) ListTokens() ([]TokenView, error) {
	doc, err := s.tokens.Read()
	if err != nil {
		return nil, err
	}
	out := make([]TokenView, 0, len(doc.Tokens))
	for _, rec := range doc.Tokens {
		out = append(out, rec.View())
	}
	sortByCreatedDesc(out)
	return out, nil
}

// RevokeToken marks a token revoked.
func (s *Service) RevokeToken(id string) error {
	return s.tokens.Update(func(doc *tokenDoc) error {
		rec, ok := doc.Tokens[id]
		if !ok {
			return protocol.NotFound("token", id)
		}
		if rec.RevokedAt == nil {
			rec.RevokedAt = protocol.StrPtr(s.Now())
			doc.Tokens[id] = rec
		}
		return nil
	})
}

// AuthenticateToken validates an API token and returns a principal.
func (s *Service) AuthenticateToken(raw string) (Principal, bool) {
	if !strings.HasPrefix(raw, APITokenPrefix) {
		return Principal{}, false
	}
	hash := SHA256Hex(raw)
	var matched TokenRecord
	found := false
	err := s.tokens.Update(func(doc *tokenDoc) error {
		for id, rec := range doc.Tokens {
			if ConstantTimeEqual(rec.Hash, hash) {
				if rec.RevokedAt != nil || expiredPtr(rec.ExpiresAt, s.now().UTC()) {
					return nil
				}
				rec.LastUsedAt = protocol.StrPtr(s.Now())
				doc.Tokens[id] = rec
				matched = rec
				found = true
				return nil
			}
		}
		return nil
	})
	if err != nil || !found {
		return Principal{}, false
	}
	return Principal{
		User:     s.User(),
		AuthType: "token",
		Scope:    matched.Scope,
		TokenID:  matched.ID,
	}, true
}

/* ------------------------------ WS tickets ------------------------------ */

type ticketRecord struct {
	MachineID string
	Purpose   string
	Expires   time.Time
}

type ticketStore struct {
	mu    sync.Mutex
	items map[string]ticketRecord
}

func newTicketStore() *ticketStore {
	return &ticketStore{items: map[string]ticketRecord{}}
}

// IssueTicket creates a one-shot ticket bound to a machine and purpose.
func (s *Service) IssueTicket(machineID, purpose string) (string, string) {
	now := s.now().UTC()
	ticket := NewSecret("wst_", 32)
	s.tickets.mu.Lock()
	for key, rec := range s.tickets.items {
		if now.After(rec.Expires) {
			delete(s.tickets.items, key)
		}
	}
	s.tickets.items[ticket] = ticketRecord{MachineID: machineID, Purpose: purpose, Expires: now.Add(TicketTTL)}
	s.tickets.mu.Unlock()
	return ticket, now.Add(TicketTTL).Format(time.RFC3339)
}

// RedeemTicket consumes a ticket; machineID/purpose must match.
func (s *Service) RedeemTicket(ticket, machineID, purpose string) bool {
	if ticket == "" {
		return false
	}
	s.tickets.mu.Lock()
	defer s.tickets.mu.Unlock()
	rec, ok := s.tickets.items[ticket]
	if !ok {
		return false
	}
	delete(s.tickets.items, ticket)
	if s.now().UTC().After(rec.Expires) {
		return false
	}
	if rec.MachineID != machineID || rec.Purpose != purpose {
		return false
	}
	return true
}

func expired(at string, now time.Time) bool {
	if at == "" {
		return true
	}
	t, err := time.Parse(time.RFC3339, at)
	if err != nil {
		return true
	}
	return now.After(t)
}

func expiredPtr(at *string, now time.Time) bool {
	if at == nil {
		return false
	}
	return expired(*at, now)
}

func sortByCreatedDesc(items []TokenView) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j].CreatedAt > items[j-1].CreatedAt; j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

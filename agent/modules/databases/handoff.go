package databases

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/internal/protocol"
)

// handoffEntry is one unconsumed dbx ticket.
type handoffEntry struct {
	profileID string
	kind      string
	expires   time.Time
}

// handoffStore keeps one-shot handoff tickets in memory. A worker restart
// invalidates every ticket, as the contract allows.
type handoffStore struct {
	mu    sync.Mutex
	items map[string]handoffEntry
}

func newHandoffStore() *handoffStore {
	return &handoffStore{items: map[string]handoffEntry{}}
}

// issue mints a 32-byte random ticket valid for ttl and returns it with its
// expiry. Expired tickets are swept opportunistically.
func (s *handoffStore) issue(profileID, kind string, ttl time.Duration) (string, time.Time, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, err
	}
	ticket := "tk_" + base64.RawURLEncoding.EncodeToString(buf)
	now := time.Now()
	expires := now.Add(ttl)
	s.mu.Lock()
	for key, entry := range s.items {
		if now.After(entry.expires) {
			delete(s.items, key)
		}
	}
	s.items[ticket] = handoffEntry{profileID: profileID, kind: kind, expires: expires}
	s.mu.Unlock()
	return ticket, expires, nil
}

// redeem atomically consumes a ticket. Invalid, expired and already-used
// tickets are indistinguishable (all false).
func (s *handoffStore) redeem(ticket string) (handoffEntry, bool) {
	if ticket == "" {
		return handoffEntry{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.items[ticket]
	if !ok {
		return handoffEntry{}, false
	}
	delete(s.items, ticket)
	if time.Now().After(entry.expires) {
		return handoffEntry{}, false
	}
	return entry, true
}

// ticketFingerprint is the only ticket-derived value that may be logged:
// SHA-256 prefix, per contract §8.4.
func ticketFingerprint(ticket string) string {
	sum := sha256.Sum256([]byte(ticket))
	return hex.EncodeToString(sum[:])[:8]
}

// buildHandoffPayload assembles dbx connection details, including the only
// plaintext password the API ever returns.
func buildHandoffPayload(profile profileRecord, password string) HandoffPayload {
	payload := HandoffPayload{
		ProfileID: profile.ID,
		Name:      profile.Name,
		Kind:      profile.Kind,
		Host:      profile.Host,
		Port:      profile.Port,
		Username:  profile.Username,
		Database:  profile.Database,
		TLS:       profile.TLS,
		RedisDB:   profile.RedisDB,
	}
	if profile.PasswordEnc != "" {
		value := password
		payload.Password = &value
	}
	switch profile.Kind {
	case kindPostgres:
		payload.ConnectionString = postgresDSN(profile, password)
	case kindRedis:
		payload.ConnectionString = redisConnectionString(profile, password)
	}
	return payload
}

// redisConnectionString builds redis:// or rediss:// including the password in
// the userinfo component.
func redisConnectionString(profile profileRecord, password string) string {
	scheme := "redis"
	if profile.TLS {
		scheme = "rediss"
	}
	db := 0
	if profile.RedisDB != nil {
		db = *profile.RedisDB
	}
	dsn := &url.URL{
		Scheme: scheme,
		Host:   net.JoinHostPort(dialHost(profile.Host), strconv.Itoa(profile.Port)),
		Path:   "/" + strconv.Itoa(db),
	}
	user := profile.usernameValue()
	switch {
	case user != "" && password != "":
		dsn.User = url.UserPassword(user, password)
	case user != "":
		dsn.User = url.User(user)
	case password != "":
		// Redis accepts `redis://:password@host/db` for the default user.
		dsn.User = url.UserPassword("", password)
	}
	return dsn.String()
}

// parseRedeemLimit reads MPANEL_REDEEM_RATE_LIMIT (attempts per minute,
// contract default 10).
func parseRedeemLimit() int {
	raw := strings.TrimSpace(os.Getenv("MPANEL_REDEEM_RATE_LIMIT"))
	if raw == "" {
		return 10
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 10
	}
	return value
}

// parseDBXOrigins reads MPANEL_DBX_ORIGIN as a comma-separated allowlist.
func parseDBXOrigins() (map[string]struct{}, bool) {
	allowed := make(map[string]struct{})
	any := false
	raw := os.Getenv("MPANEL_DBX_ORIGIN")
	for _, part := range strings.Split(raw, ",") {
		origin := strings.ToLower(strings.TrimSpace(part))
		if origin == "" {
			continue
		}
		if origin == "*" {
			any = true
			continue
		}
		allowed[origin] = struct{}{}
	}
	return allowed, any
}

// applyRedeemCORS narrows the agent's default CORS reflection to the configured
// dbx origin. Credentials are never allowed on the redeem endpoint.
func (m *Module) applyRedeemCORS(w http.Header, origin string) {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return
	}
	_, allowed := m.dbxOrigins[strings.ToLower(origin)]
	if !allowed && !m.dbxAllowAny {
		w.Del("Access-Control-Allow-Origin")
		w.Del("Access-Control-Allow-Credentials")
		return
	}
	w.Set("Access-Control-Allow-Origin", origin)
	w.Del("Access-Control-Allow-Credentials")
	w.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Set("Access-Control-Allow-Headers", "Content-Type")
	w.Set("Access-Control-Max-Age", "600")
	w.Add("Vary", "Origin")
}

// handoffError renders an invalid/expired/used ticket. The contract requires
// NOT_FOUND and deliberately does not distinguish the three cases.
func handoffError() error {
	return &protocol.PanelError{
		Code:    protocol.CodeNotFound,
		Message: "handoff 票据无效、已过期或已使用",
		Details: map[string]any{"resource": "handoffTicket"},
	}
}

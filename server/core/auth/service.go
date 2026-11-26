// Package auth implements the core control plane's credentials: the scrypt
// password, sliding sessions persisted under db/, API tokens, one-shot WS
// tickets, the login rate limiter and the first-run bootstrap token.
package auth

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
	"github.com/sakana-1314/mpanel/server/core/store"
)

const (
	// SessionTTL is the session lifetime; the JWT exp matches it.
	SessionTTL = 12 * time.Hour
	// TicketTTL is the WS ticket lifetime.
	TicketTTL = 60 * time.Second
	// APITokenPrefix marks panel API tokens.
	APITokenPrefix = "mpanel_"
	// BootstrapFileName is created under conf/ on first start.
	BootstrapFileName = "bootstrap-token"
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$`)

// User is the authenticated principal shape shared with the frontend.
type User struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"displayName"`
	Role        string  `json:"role"`
}

// Principal is the result of authenticating an HTTP request.
type Principal struct {
	User      User
	AuthType  string // "session" | "token"
	Scope     string // "read" | "write"
	SessionID string
	TokenID   string
	Static    bool // true for MPANEL_CORE_TOKEN
}

// Service owns the persistent credential state.
type Service struct {
	cfg     *config.App
	log     *slog.Logger
	baseDir string
	dbDir   string
	confDir string
	key     []byte

	sessions *store.Store[sessionDoc]
	tokens   *store.Store[tokenDoc]
	tickets  *ticketStore
	limiter  *LoginLimiter

	mu  sync.Mutex // serialises writes to cfg.System.{Username,Password}
	now func() time.Time
}

// New opens the credential stores and, when no password is configured yet,
// creates conf/bootstrap-token with mode 0600.
func New(cfg *config.App, logger *slog.Logger) (*Service, error) {
	if cfg == nil {
		return nil, fmt.Errorf("auth: 配置不能为空")
	}
	if logger == nil {
		logger = slog.Default()
	}
	s := &Service{
		cfg:     cfg,
		log:     logger,
		baseDir: cfg.System.BaseDir,
		dbDir:   cfg.System.DBPath,
		confDir: filepath.Join(cfg.System.BaseDir, "conf"),
		key:     EncryptKey(cfg.System.Secret),
		now:     time.Now,
	}
	if s.dbDir == "" {
		s.dbDir = filepath.Join(cfg.System.BaseDir, "db")
	}
	if err := os.MkdirAll(s.dbDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.confDir, 0o700); err != nil {
		return nil, err
	}
	s.sessions = store.Open(filepath.Join(s.dbDir, "sessions.json"), func() sessionDoc {
		return sessionDoc{Sessions: map[string]SessionRecord{}}
	})
	s.tokens = store.Open(filepath.Join(s.dbDir, "tokens.json"), func() tokenDoc {
		return tokenDoc{Tokens: map[string]TokenRecord{}}
	})
	s.tickets = newTicketStore()
	s.limiter = NewLoginLimiter(5, time.Minute)
	if !s.Configured() {
		token, path, err := s.EnsureBootstrap()
		if err != nil {
			return nil, err
		}
		s.log.Info("尚未设置面板密码，已准备 bootstrap token", "path", path, "tokenLength", len(token))
	}
	return s, nil
}

// BootstrapPath returns conf/bootstrap-token.
func (s *Service) BootstrapPath() string { return filepath.Join(s.confDir, BootstrapFileName) }

// EnsureBootstrap creates (or re-reads) the bootstrap token and returns it.
func (s *Service) EnsureBootstrap() (token, path string, err error) {
	path = s.BootstrapPath()
	if data, readErr := os.ReadFile(path); readErr == nil {
		value := strings.TrimSpace(string(data))
		if value != "" {
			return value, path, nil
		}
	}
	token = NewSecret("bt_", 32)
	if err := config.WriteFileAtomic(path, []byte(token+"\n"), 0o600); err != nil {
		return "", path, err
	}
	return token, path, nil
}

// BootstrapToken reads the current bootstrap token, if any.
func (s *Service) BootstrapToken() (string, bool) {
	data, err := os.ReadFile(s.BootstrapPath())
	if err != nil {
		return "", false
	}
	value := strings.TrimSpace(string(data))
	return value, value != ""
}

// Configured reports whether a password has been set.
func (s *Service) Configured() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.System.Password != ""
}

// Username returns the configured username (default admin).
func (s *Service) Username() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cfg.System.Username == "" {
		return "admin"
	}
	return s.cfg.System.Username
}

// User returns the single panel user.
func (s *Service) User() User {
	name := s.Username()
	return User{
		ID:          userIDFor(name),
		Username:    name,
		DisplayName: nil,
		Role:        "admin",
	}
}

func userIDFor(username string) string {
	sum := SHA256Hex("mpanel-user:" + username)
	return "usr_" + sum[:12]
}

// Setup consumes the bootstrap token and sets the first password.
func (s *Service) Setup(bootstrapToken, username, password string) (User, error) {
	if s.Configured() {
		return User{}, &protocol.PanelError{Code: protocol.CodeConflict, Message: "面板已完成初始化"}
	}
	expected, ok := s.BootstrapToken()
	if !ok {
		return User{}, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "bootstrap token 不存在，请重启 core 重新生成"}
	}
	if !ConstantTimeEqual(strings.TrimSpace(bootstrapToken), expected) {
		return User{}, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "bootstrap token 无效"}
	}
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return User{}, &protocol.PanelError{Code: protocol.CodeBadRequest, Message: "用户名格式无效", Hint: "3–32 位字母、数字、下划线、点或短横线，且以字母或数字开头。"}
	}
	if len([]rune(password)) < 10 {
		return User{}, &protocol.PanelError{Code: protocol.CodeBadRequest, Message: "密码至少 10 个字符"}
	}
	hash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}
	s.mu.Lock()
	s.cfg.System.Username = username
	s.cfg.System.Password = hash
	err = config.SaveApp(s.cfg)
	s.mu.Unlock()
	if err != nil {
		return User{}, err
	}
	_ = os.Remove(s.BootstrapPath())
	s.log.Info("面板初始化完成", "username", username)
	return s.User(), nil
}

// Login validates credentials. Rate limiting happens before the password check
// and counts successful attempts too.
func (s *Service) Login(username, password, ip string) (SessionRecord, User, error) {
	if allowed, retry := s.limiter.Hit(ip); !allowed {
		return SessionRecord{}, User{}, &protocol.PanelError{
			Code:    protocol.CodeUnauthorized,
			Message: "登录尝试过于频繁",
			Details: map[string]any{"retryAfterSec": retry},
		}
	}
	s.mu.Lock()
	configured := s.cfg.System.Password
	s.mu.Unlock()
	if configured == "" {
		return SessionRecord{}, User{}, &protocol.PanelError{
			Code:    protocol.CodeUnauthorized,
			Message: "面板尚未初始化",
			Details: map[string]any{"hint": "使用 conf/bootstrap-token 调用 POST /api/v1/auth/setup。"},
		}
	}
	if !ConstantTimeEqual(strings.TrimSpace(username), s.Username()) || !VerifyPassword(configured, password) {
		return SessionRecord{}, User{}, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "用户名或密码错误"}
	}
	rec, err := s.CreateSession()
	if err != nil {
		return SessionRecord{}, User{}, err
	}
	return rec, s.User(), nil
}

// ChangePassword verifies the current password, stores a new hash and revokes
// every other session.
func (s *Service) ChangePassword(current, next, keepSessionID string) error {
	s.mu.Lock()
	configured := s.cfg.System.Password
	s.mu.Unlock()
	if configured == "" {
		return &protocol.PanelError{Code: protocol.CodeBadRequest, Message: "尚未设置密码"}
	}
	if !VerifyPassword(configured, current) {
		return &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "当前密码错误"}
	}
	if len([]rune(next)) < 10 {
		return &protocol.PanelError{Code: protocol.CodeBadRequest, Message: "新密码至少 10 个字符"}
	}
	if next == current {
		return &protocol.PanelError{Code: protocol.CodeBadRequest, Message: "新密码不能与当前密码相同"}
	}
	hash, err := HashPassword(next)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg.System.Password = hash
	err = config.SaveApp(s.cfg)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.DeleteOtherSessions(keepSessionID)
}

// ResetPassword clears the password and returns a fresh bootstrap token.
func (s *Service) ResetPassword() (token, path string, err error) {
	s.mu.Lock()
	s.cfg.System.Password = ""
	err = config.SaveApp(s.cfg)
	s.mu.Unlock()
	if err != nil {
		return "", "", err
	}
	token, path, err = s.EnsureBootstrap()
	return
}

// SaveConfig persists the whole app.yaml (used after external mutations).
func (s *Service) SaveConfig() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return config.SaveApp(s.cfg)
}

// Now returns the service clock (RFC3339 UTC).
func (s *Service) Now() string { return s.now().UTC().Format(time.RFC3339) }

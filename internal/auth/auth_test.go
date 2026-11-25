package auth

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/internal/config"
)

func newTestService(t *testing.T) (*Service, *config.App) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.NewApp(dir)
	cfg.System.Secret = "unit-test-secret"
	svc, err := New(cfg, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return svc, cfg
}

func TestPasswordHashAndVerify(t *testing.T) {
	hash, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("wrong password accepted")
	}
	if !VerifyPassword(hash, "correct horse battery") {
		t.Fatal("correct password rejected")
	}
}

func TestSetupLoginAndSession(t *testing.T) {
	svc, cfg := newTestService(t)
	token, _, err := svc.EnsureBootstrap()
	if err != nil {
		t.Fatalf("EnsureBootstrap: %v", err)
	}
	if _, err := svc.Setup("bad-token", "admin", "a-long-password"); err == nil {
		t.Fatal("setup accepted a wrong bootstrap token")
	}
	user, err := svc.Setup(token, "admin", "a-long-password")
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if user.Username != "admin" {
		t.Fatalf("username = %q", user.Username)
	}
	if cfg.System.Password == "" {
		t.Fatal("password hash not persisted in config")
	}
	if _, _, err := svc.Login("admin", "wrong-password", "127.0.0.1"); err == nil {
		t.Fatal("login accepted a wrong password")
	}
	session, _, err := svc.Login("admin", "a-long-password", "127.0.0.1")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if _, ok := svc.Session(session.ID); !ok {
		t.Fatal("session not found")
	}
	if _, ok := svc.TouchSession(session.ID); !ok {
		t.Fatal("touch failed")
	}
	if err := svc.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, ok := svc.Session(session.ID); ok {
		t.Fatal("deleted session still valid")
	}
}

func TestLoginLimiterDoesNotResetOnSuccess(t *testing.T) {
	svc, _ := newTestService(t)
	token, _, _ := svc.EnsureBootstrap()
	if _, err := svc.Setup(token, "admin", "a-long-password"); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	// Burn the bucket with failures.
	for i := 0; i < 5; i++ {
		_, _, _ = svc.Login("admin", "bad", "10.0.0.1")
	}
	if _, _, err := svc.Login("admin", "a-long-password", "10.0.0.1"); err == nil {
		t.Fatal("successful login bypassed the rate limit")
	}
}

func TestAPITokenLifecycle(t *testing.T) {
	svc, _ := newTestService(t)
	view, secret, err := svc.CreateToken("ci", "read", 0)
	if err != nil {
		t.Fatalf("CreateToken: %v", err)
	}
	principal, ok := svc.AuthenticateToken(secret)
	if !ok {
		t.Fatal("token rejected")
	}
	if principal.Scope != "read" {
		t.Fatalf("scope = %q", principal.Scope)
	}
	if _, ok := svc.AuthenticateToken(secret + "x"); ok {
		t.Fatal("tampered token accepted")
	}
	if err := svc.RevokeToken(view.ID); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, ok := svc.AuthenticateToken(secret); ok {
		t.Fatal("revoked token accepted")
	}
}

func TestWSTicketIsOneShot(t *testing.T) {
	svc, _ := newTestService(t)
	ticket, _ := svc.IssueTicket("m_1", "/ws/terminal/t")
	if !svc.RedeemTicket(ticket, "m_1", "/ws/terminal/t") {
		t.Fatal("valid ticket rejected")
	}
	if svc.RedeemTicket(ticket, "m_1", "/ws/terminal/t") {
		t.Fatal("ticket reused")
	}
	second, _ := svc.IssueTicket("m_1", "/ws/terminal/t")
	if svc.RedeemTicket(second, "m_2", "/ws/terminal/t") {
		t.Fatal("ticket accepted for a different machine")
	}
}

func TestCipherRoundTrip(t *testing.T) {
	key := EncryptKey("secret")
	sealed, err := Seal(key, "hello")
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	plain, err := Open(key, sealed)
	if err != nil || plain != "hello" {
		t.Fatalf("Open = %q, %v", plain, err)
	}
	if _, err := Open(EncryptKey("other"), sealed); err == nil {
		t.Fatal("wrong key decrypted ciphertext")
	}
}

func TestBootstrapFilePermissions(t *testing.T) {
	if os.Getenv("CI") == "" {
		t.Skip("permission bits are only meaningful on POSIX CI")
	}
	svc, cfg := newTestService(t)
	if _, _, err := svc.EnsureBootstrap(); err != nil {
		t.Fatalf("EnsureBootstrap: %v", err)
	}
	info, err := os.Stat(filepath.Join(cfg.System.BaseDir, "conf", BootstrapFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("bootstrap token permissions = %v", info.Mode().Perm())
	}
}

var _ = time.Now

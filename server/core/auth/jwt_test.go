package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
)

func jwtTestService(t *testing.T) *Service {
	t.Helper()
	cfg := config.NewApp(t.TempDir())
	svc, err := New(cfg, nil)
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	return svc
}

func TestJWTIssueAndVerify(t *testing.T) {
	svc := jwtTestService(t)
	session, err := svc.CreateSession()
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	token, err := svc.IssueJWT(session)
	if err != nil {
		t.Fatalf("IssueJWT: %v", err)
	}
	if strings.Count(token, ".") != 2 {
		t.Fatalf("token is not a three-part JWT: %q", token)
	}
	claims, err := svc.VerifyJWT(token)
	if err != nil {
		t.Fatalf("VerifyJWT: %v", err)
	}
	if claims.SessionID != session.ID {
		t.Fatalf("sid = %q, want %q", claims.SessionID, session.ID)
	}
	if claims.Issuer != JWTIssuer {
		t.Fatalf("iss = %q, want %q", claims.Issuer, JWTIssuer)
	}
	if claims.Role != "admin" || claims.Subject == "" {
		t.Fatalf("unexpected claims: %#v", claims)
	}
}

func TestJWTRejectsTamperedSignature(t *testing.T) {
	svc := jwtTestService(t)
	session, _ := svc.CreateSession()
	token, _ := svc.IssueJWT(session)

	tampered := token[:len(token)-2] + "xx"
	if _, err := svc.VerifyJWT(tampered); err == nil {
		t.Fatal("tampered signature must be rejected")
	}
}

func TestJWTRejectsTamperedPayload(t *testing.T) {
	svc := jwtTestService(t)
	session, _ := svc.CreateSession()
	token, _ := svc.IssueJWT(session)

	parts := strings.Split(token, ".")
	forged := parts[0] + "." + base64URL([]byte(`{"iss":"mpanel-core","sub":"admin","role":"admin","sid":"sess_forged","exp":9999999999}`)) + "." + parts[2]
	if _, err := svc.VerifyJWT(forged); err == nil {
		t.Fatal("payload swap without re-signing must be rejected")
	}
}

func TestJWTRejectsForeignSecret(t *testing.T) {
	issuer := jwtTestService(t)
	session, _ := issuer.CreateSession()
	token, _ := issuer.IssueJWT(session)

	verifier := jwtTestService(t) // 不同 secret
	if _, err := verifier.VerifyJWT(token); err == nil {
		t.Fatal("token signed with another secret must be rejected")
	}
}

func TestJWTRejectsExpiredToken(t *testing.T) {
	svc := jwtTestService(t)
	session, _ := svc.CreateSession()
	token, _ := svc.IssueJWT(session)

	// 时钟推进到 token 过期之后。
	svc.now = func() time.Time { return time.Now().Add(SessionTTL + time.Hour) }
	if _, err := svc.VerifyJWT(token); err == nil {
		t.Fatal("expired token must be rejected")
	}
}

func TestJWTRejectsMalformedTokens(t *testing.T) {
	svc := jwtTestService(t)
	for _, token := range []string{"", "abc", "a.b", "a.b.c.d", "..", "not.a.jwt"} {
		if _, err := svc.VerifyJWT(token); err == nil {
			t.Fatalf("malformed token %q must be rejected", token)
		}
	}
}

package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// JWT 鉴权：面板不再依赖 Cookie，浏览器把 token 放在 Authorization 头里。
// 因此请求不再自动携带凭据，CORS 可以放开任意来源。

const (
	// JWTIssuer 是签发给面板会话的 iss 值，校验时用于拒绝其它来源的 token。
	JWTIssuer = "mpanel-core"
)

// JWTClaims 是本系统签发的会话负载。字段名沿用标准短名，便于第三方工具解析。
type JWTClaims struct {
	Issuer    string `json:"iss"`
	Subject   string `json:"sub"` // 用户名
	UserID    string `json:"uid"`
	Role      string `json:"role"`
	AuthType  string `json:"typ"` // "session"
	SessionID string `json:"sid"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func base64URL(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// jwtSigningKey 从配置里的 secret 派生固定 32 字节的 HS256 密钥。
// 用 SHA-256 派生而不是直接取字节，这样任何长度的 secret 都能用，
// 且不会因为配置短而削弱签名强度。
func jwtSigningKey(secret string) ([]byte, error) {
	if strings.TrimSpace(secret) == "" {
		return nil, errors.New("JWT 签名密钥未配置")
	}
	sum := sha256.Sum256([]byte("mpanel-jwt:" + secret))
	return sum[:], nil
}

// IssueJWT 用 HS256 签发会话 token。secret 取 cfg.System.Secret。
func (s *Service) IssueJWT(session SessionRecord) (string, error) {
	key, err := jwtSigningKey(s.cfg.System.Secret)
	if err != nil {
		return "", err
	}
	now := s.now().UTC()
	claims := JWTClaims{
		Issuer:    JWTIssuer,
		Subject:   session.Username,
		UserID:    userIDFor(session.Username),
		Role:      session.Role,
		AuthType:  "session",
		SessionID: session.ID,
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(SessionTTL).Unix(),
	}
	header := base64URL([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := header + "." + base64URL(payload)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	return signingInput + "." + base64URL(mac.Sum(nil)), nil
}

// VerifyJWT 校验签名、iss 与 exp，返回 claims。
func (s *Service) VerifyJWT(token string) (JWTClaims, error) {
	invalid := &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "登录已过期，请重新登录"}
	key, err := jwtSigningKey(s.cfg.System.Secret)
	if err != nil {
		return JWTClaims{}, invalid
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return JWTClaims{}, invalid
	}
	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	if !hmac.Equal(mac.Sum(nil), mustBase64URL(parts[2])) {
		return JWTClaims{}, invalid
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if raw := mustBase64URL(parts[0]); json.Unmarshal(raw, &header) != nil || header.Alg != "HS256" {
		return JWTClaims{}, invalid
	}
	var claims JWTClaims
	if json.Unmarshal(mustBase64URL(parts[1]), &claims) != nil {
		return JWTClaims{}, invalid
	}
	if claims.Issuer != JWTIssuer {
		return JWTClaims{}, invalid
	}
	if claims.ExpiresAt == 0 || s.now().UTC().Unix() >= claims.ExpiresAt {
		return JWTClaims{}, invalid
	}
	if claims.Subject == "" || claims.SessionID == "" {
		return JWTClaims{}, invalid
	}
	return claims, nil
}

func mustBase64URL(value string) []byte {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil
	}
	return decoded
}

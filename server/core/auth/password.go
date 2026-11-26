package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
)

// Password hashing parameters are fixed by notes/go-design.md §2.3.
const (
	scryptN       = 32768
	scryptR       = 8
	scryptP       = 1
	scryptKeyLen  = 32
	scryptSaltLen = 16
)

// HashPassword derives an encoded scrypt hash:
//
//	scrypt$N$r$p$<salt-b64>$<key-b64>
func HashPassword(password string) (string, error) {
	salt := make([]byte, scryptSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("scrypt$%d$%d$%d$%s$%s",
		scryptN, scryptR, scryptP,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks password against an encoded scrypt hash in constant
// time with respect to the derived key.
func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false
	}
	n, err1 := strconv.Atoi(parts[1])
	r, err2 := strconv.Atoi(parts[2])
	p, err3 := strconv.Atoi(parts[3])
	if err1 != nil || err2 != nil || err3 != nil || n <= 0 || r <= 0 || p <= 0 {
		return false
	}
	// Refuse absurd parameters so a corrupted config cannot exhaust memory.
	if n > 1<<20 || r > 32 || p > 16 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	key, err := scrypt.Key([]byte(password), salt, n, r, p, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(key, want) == 1
}

// ConstantTimeEqual compares two strings without leaking their contents.
func ConstantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// SHA256Hex returns the lowercase hex SHA-256 of s. It is the only form in
// which API tokens, machine secrets and edge keys are persisted.
func SHA256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// NewSecret returns prefix + n random bytes encoded as base64url.
func NewSecret(prefix string, n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buf)
}

// EncryptKey derives the 32-byte AES key used for machine token encryption
// from the core secret. SHA-256 is used so any secret length is acceptable.
func EncryptKey(secret string) []byte {
	sum := sha256.Sum256([]byte("mpanel-token-key:" + secret))
	return sum[:]
}

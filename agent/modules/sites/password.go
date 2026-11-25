package sites

import "golang.org/x/crypto/bcrypt"

// bcryptGenerate is isolated so a build without entropy can be reported as
// UNAVAILABLE rather than silently storing a plaintext password.
func bcryptGenerate(password []byte) (string, error) {
	hash, err := bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// validBcryptHash reports whether value is a parseable bcrypt hash.
func validBcryptHash(value string) bool {
	if value == "" {
		return false
	}
	_, err := bcrypt.Cost([]byte(value))
	return err == nil
}

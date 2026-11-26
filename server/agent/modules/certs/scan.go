package certs

import (
	"crypto/dsa"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"io/fs"
	"math"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxCertificateFileBytes = 4 << 20

// scanCertificates walks <dataDir>/certificates for .crt/.pem files and parses
// every X.509 certificate it finds. Duplicates (same SHA-256 fingerprint) keep
// the first path. Parse failures are warnings, never request failures.
func scanCertificates(dataDir string, now time.Time) ([]CertificateInfo, []string) {
	certificatesDir := filepath.Join(dataDir, "certificates")
	info, err := os.Stat(certificatesDir)
	if err != nil || !info.IsDir() {
		return []CertificateInfo{}, nil
	}
	var (
		items    []CertificateInfo
		warnings []string
		seen     = map[string]bool{}
	)
	walkErr := filepath.WalkDir(certificatesDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			warnings = append(warnings, path+": "+err.Error())
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil // never follow symlinks
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".crt" && ext != ".pem" {
			return nil
		}
		fileInfo, err := entry.Info()
		if err != nil {
			warnings = append(warnings, path+": "+err.Error())
			return nil
		}
		if fileInfo.Size() > maxCertificateFileBytes {
			warnings = append(warnings, path+": 证书文件超过 4 MiB，已跳过")
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			warnings = append(warnings, path+": "+err.Error())
			return nil
		}
		certificates, parseWarnings := parseCertificates(data)
		for _, warning := range parseWarnings {
			warnings = append(warnings, path+": "+warning)
		}
		for _, cert := range certificates {
			certInfo := certificateInfo(cert, path, now)
			if seen[certInfo.ID] {
				continue
			}
			seen[certInfo.ID] = true
			items = append(items, certInfo)
		}
		return nil
	})
	if walkErr != nil {
		warnings = append(warnings, certificatesDir+": "+walkErr.Error())
	}
	if items == nil {
		items = []CertificateInfo{}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].NotAfter != items[j].NotAfter {
			return items[i].NotAfter < items[j].NotAfter
		}
		return items[i].ID < items[j].ID
	})
	return items, warnings
}

// parseCertificates decodes PEM certificate blocks, ignoring keys and CSRs.
// A bare DER certificate is accepted as a fallback.
func parseCertificates(data []byte) ([]*x509.Certificate, []string) {
	var (
		certificates []*x509.Certificate
		warnings     []string
		rest         = data
		sawPEM       bool
	)
	for {
		block, remaining := pem.Decode(rest)
		if block == nil {
			break
		}
		sawPEM = true
		rest = remaining
		if block.Type != "CERTIFICATE" {
			continue // private keys, CSRs, etc. are never inspected
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			warnings = append(warnings, "PEM 证书解析失败: "+err.Error())
			continue
		}
		certificates = append(certificates, cert)
	}
	if len(certificates) == 0 && !sawPEM {
		if cert, err := x509.ParseCertificate(data); err == nil {
			certificates = append(certificates, cert)
		} else {
			warnings = append(warnings, "不是可解析的 X.509 证书")
		}
	} else if len(certificates) == 0 && sawPEM {
		warnings = append(warnings, "PEM 文件中没有证书块")
	}
	return certificates, warnings
}

func certificateInfo(cert *x509.Certificate, path string, now time.Time) CertificateInfo {
	sum := sha256.Sum256(cert.Raw)
	fingerprint := hex.EncodeToString(sum[:])
	notAfter := cert.NotAfter.UTC()
	daysRemaining := 0
	status := StatusUnknown
	if !notAfter.IsZero() {
		daysRemaining = int(math.Floor(notAfter.Sub(now).Hours() / 24))
		switch {
		case daysRemaining < 0:
			status = StatusExpired
		case daysRemaining <= ExpiringDays:
			status = StatusExpiring
		default:
			status = StatusValid
		}
	}
	serial := ""
	if cert.SerialNumber != nil {
		serial = cert.SerialNumber.Text(16)
	}
	return CertificateInfo{
		ID:                fingerprint,
		Domains:           collectDomains(cert),
		CommonName:        stringPtr(cert.Subject.CommonName),
		Issuer:            nameString(cert.Issuer),
		Subject:           nameString(cert.Subject),
		NotBefore:         cert.NotBefore.UTC().Format(time.RFC3339),
		NotAfter:          notAfter.Format(time.RFC3339),
		DaysRemaining:     daysRemaining,
		SerialNumber:      serial,
		FingerprintSHA256: fingerprint,
		KeyType:           keyType(cert),
		Source:            certificateSource(cert, path),
		Path:              path,
		Status:            status,
	}
}

func collectDomains(cert *x509.Certificate) []string {
	out := make([]string, 0, len(cert.DNSNames)+1)
	seen := map[string]bool{}
	add := func(domain string) {
		domain = strings.TrimSpace(domain)
		if domain == "" || net.ParseIP(domain) != nil {
			return
		}
		key := strings.ToLower(domain)
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, domain)
	}
	for _, domain := range cert.DNSNames {
		add(domain)
	}
	add(cert.Subject.CommonName)
	return out
}

func nameString(name pkix.Name) string {
	if name.CommonName != "" {
		return name.CommonName
	}
	return name.String()
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func keyType(cert *x509.Certificate) *string {
	var value string
	switch publicKey := cert.PublicKey.(type) {
	case *rsa.PublicKey:
		value = "RSA-" + strconv.Itoa(publicKey.N.BitLen())
	case *ecdsa.PublicKey:
		value = "ECDSA-" + publicKey.Curve.Params().Name
	case ed25519.PublicKey:
		value = "Ed25519"
	case *dsa.PublicKey:
		value = "DSA-" + strconv.Itoa(publicKey.P.BitLen())
	default:
		return nil
	}
	return &value
}

// certificateSource classifies the issuer as Caddy's local CA, an ACME
// authority, or unknown. It is informational only.
func certificateSource(cert *x509.Certificate, path string) string {
	issuer := strings.ToLower(cert.Issuer.String())
	normalized := strings.ToLower(filepath.ToSlash(path))
	if strings.Contains(issuer, "caddy local authority") || strings.Contains(issuer, "local authority") ||
		strings.Contains(normalized, "/certificates/local/") {
		return "local"
	}
	for _, marker := range []string{
		"let's encrypt", "letsencrypt", "zerossl", "buypass",
		"google trust services", "acme",
	} {
		if strings.Contains(issuer, marker) {
			return "acme"
		}
	}
	if strings.Contains(normalized, "acme-v02") || strings.Contains(normalized, "acme-v01") ||
		strings.Contains(normalized, "/acme/") {
		return "acme"
	}
	return "unknown"
}

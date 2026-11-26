package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTestCertificate(t *testing.T, dataDir, rel string, notBefore, notAfter time.Time, dnsNames []string, commonName string) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		t.Fatalf("生成序列号失败: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		DNSNames:              dnsNames,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("签发自签证书失败: %v", err)
	}
	path := filepath.Join(dataDir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("写入证书失败: %v", err)
	}
	return path
}

func TestScanCertificatesParsesAndClassifiesExpiry(t *testing.T) {
	now := time.Date(2026, time.January, 1, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	validPath := writeTestCertificate(t, dir, "certificates/local/valid/valid.crt",
		now.Add(-24*time.Hour), now.Add(365*24*time.Hour), []string{"valid.example.com"}, "valid.example.com")
	writeTestCertificate(t, dir, "certificates/local/expiring/expiring.crt",
		now.Add(-24*time.Hour), now.Add(10*24*time.Hour), []string{"expiring.example.com"}, "expiring.example.com")
	writeTestCertificate(t, dir, "certificates/local/expired/expired.crt",
		now.Add(-48*time.Hour), now.Add(-2*24*time.Hour), []string{"expired.example.com"}, "expired.example.com")

	items, warnings := scanCertificates(dir, now)
	if len(warnings) != 0 {
		t.Fatalf("不应有解析警告: %v", warnings)
	}
	if len(items) != 3 {
		t.Fatalf("期望 3 张证书，得到 %d", len(items))
	}
	byDomain := map[string]CertificateInfo{}
	for _, item := range items {
		if len(item.Domains) == 0 {
			t.Fatalf("证书缺少域名: %+v", item)
		}
		byDomain[item.Domains[0]] = item
	}
	valid := byDomain["valid.example.com"]
	if valid.Status != StatusValid || valid.DaysRemaining != 365 {
		t.Fatalf("valid 状态错误: %+v", valid)
	}
	if valid.Issuer != "valid.example.com" || valid.Subject != "valid.example.com" {
		t.Fatalf("issuer/subject 错误: %+v", valid)
	}
	if valid.CommonName == nil || *valid.CommonName != "valid.example.com" {
		t.Fatalf("commonName 错误: %+v", valid.CommonName)
	}
	if valid.KeyType == nil || !strings.HasPrefix(*valid.KeyType, "ECDSA-") {
		t.Fatalf("keyType 错误: %+v", valid.KeyType)
	}
	if valid.Source != "local" {
		t.Fatalf("certificates/local 路径应识别为 local CA，得到 %s", valid.Source)
	}
	if valid.Path != validPath {
		t.Fatalf("path=%s, want %s", valid.Path, validPath)
	}
	if len(valid.ID) != 64 || valid.ID != valid.FingerprintSHA256 {
		t.Fatalf("指纹 id 错误: %+v", valid)
	}
	if valid.SerialNumber == "" {
		t.Fatal("serialNumber 为空")
	}
	if valid.NotAfter != now.Add(365*24*time.Hour).Format(time.RFC3339) {
		t.Fatalf("notAfter 格式错误: %s", valid.NotAfter)
	}
	if got := byDomain["expiring.example.com"]; got.Status != StatusExpiring || got.DaysRemaining != 10 {
		t.Fatalf("expiring 状态错误: %+v", got)
	}
	if got := byDomain["expired.example.com"]; got.Status != StatusExpired || got.DaysRemaining != -2 {
		t.Fatalf("expired 状态错误: %+v", got)
	}
}

func TestScanCertificatesDeduplicatesFingerprints(t *testing.T) {
	now := time.Now().UTC()
	dir := t.TempDir()
	first := writeTestCertificate(t, dir, "certificates/local/a/a.crt",
		now.Add(-time.Hour), now.Add(90*24*time.Hour), []string{"a.example.com"}, "a.example.com")
	data, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	second := filepath.Join(dir, "certificates", "local", "a", "a-copy.pem")
	if err := os.WriteFile(second, data, 0o644); err != nil {
		t.Fatal(err)
	}
	items, _ := scanCertificates(dir, now)
	if len(items) != 1 {
		t.Fatalf("同一证书的重复文件应去重，得到 %d", len(items))
	}
}

func TestScanCertificatesSkipsPrivateKeys(t *testing.T) {
	now := time.Now().UTC()
	dir := t.TempDir()
	writeTestCertificate(t, dir, "certificates/local/a/a.crt",
		now.Add(-time.Hour), now.Add(30*24*time.Hour), []string{"a.example.com"}, "a.example.com")
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, "certificates", "local", "a", "a.pem")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	items, warnings := scanCertificates(dir, now)
	if len(items) != 1 {
		t.Fatalf("私钥文件不应产生证书条目，得到 %d", len(items))
	}
	if len(warnings) == 0 {
		t.Fatal("私钥文件应产生一条警告")
	}
	if strings.Contains(strings.Join(warnings, " "), "PRIVATE") {
		t.Fatal("警告不应包含私钥内容")
	}
}

func TestScanCertificatesMissingDir(t *testing.T) {
	items, warnings := scanCertificates(t.TempDir(), time.Now())
	if len(items) != 0 || len(warnings) != 0 {
		t.Fatalf("缺少 certificates 目录应返回空列表: items=%d warnings=%v", len(items), warnings)
	}
}

func TestCertificateStatusThresholds(t *testing.T) {
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		days int
		want CertificateStatus
	}{
		{-1, StatusExpired},
		{0, StatusExpiring},
		{14, StatusExpiring},
		{15, StatusValid},
	}
	for _, tc := range cases {
		dir := t.TempDir()
		writeTestCertificate(t, dir, "certificates/local/t/t.crt",
			now.Add(-24*time.Hour), now.Add(time.Duration(tc.days)*24*time.Hour), []string{"t.example.com"}, "t.example.com")
		items, warnings := scanCertificates(dir, now)
		if len(warnings) != 0 || len(items) != 1 {
			t.Fatalf("扫描失败: items=%d warnings=%v", len(items), warnings)
		}
		if items[0].Status != tc.want {
			t.Fatalf("days=%d status=%s, want %s", tc.days, items[0].Status, tc.want)
		}
		if items[0].DaysRemaining != tc.days {
			t.Fatalf("days=%d daysRemaining=%d", tc.days, items[0].DaysRemaining)
		}
	}
}

func TestMatchesDomainWildcard(t *testing.T) {
	item := CertificateInfo{Domains: []string{"*.example.com", "api.test.dev"}}
	cases := map[string]bool{
		"foo.example.com":      true,
		"example.com":          false,
		"api.test.dev":         true,
		"API.TEST.DEV":         true,
		"other.test.dev":       false,
		"deep.foo.example.com": true,
	}
	for domain, want := range cases {
		if got := matchesDomain(item, domain); got != want {
			t.Errorf("matchesDomain(%q)=%v, want %v", domain, got, want)
		}
	}
}

func TestResolveDataDir(t *testing.T) {
	dir := t.TempDir()
	got, ok := resolveDataDir([]string{filepath.Join(dir, "missing"), dir})
	if !ok || got != dir {
		t.Fatalf("应回退到可读目录: got=%q ok=%v", got, ok)
	}
	if _, ok := resolveDataDir([]string{filepath.Join(dir, "missing")}); ok {
		t.Fatal("不存在的目录不应可用")
	}
}

func TestResolveDataDirPrefersCertificates(t *testing.T) {
	empty := t.TempDir()
	withCerts := t.TempDir()
	if err := os.MkdirAll(filepath.Join(withCerts, "certificates"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, ok := resolveDataDir([]string{empty, withCerts})
	if !ok || got != withCerts {
		t.Fatalf("应优先选择含 certificates 的目录: got=%q ok=%v", got, ok)
	}
}

func TestCertificatesHaveJSONFriendlySlices(t *testing.T) {
	now := time.Now().UTC()
	dir := t.TempDir()
	writeTestCertificate(t, dir, "certificates/local/x/x.crt",
		now, now.Add(48*time.Hour), []string{"x.test"}, "")
	items, _ := scanCertificates(dir, now)
	if len(items) != 1 {
		t.Fatalf("期望 1 张证书，得到 %d", len(items))
	}
	if items[0].Domains == nil {
		t.Fatal("domains 不应为 nil")
	}
	if items[0].CommonName != nil {
		t.Fatal("空 CN 应为 null")
	}
}

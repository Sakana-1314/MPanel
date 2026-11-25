package databases

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/sakana-1314/mpanel/internal/auth"
	"github.com/sakana-1314/mpanel/internal/config"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

// profileRecord is the on-disk profile. PasswordEnc is AES-256-GCM ciphertext
// (base64url) and never leaves the agent.
type profileRecord struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Kind        string     `json:"kind"`
	Host        string     `json:"host"`
	Port        int        `json:"port"`
	Username    *string    `json:"username,omitempty"`
	Database    *string    `json:"database,omitempty"`
	TLS         bool       `json:"tls"`
	RedisDB     *int       `json:"redisDb,omitempty"`
	PasswordEnc string     `json:"passwordEnc,omitempty"`
	LastCheck   *lastCheck `json:"lastCheck,omitempty"`
	CreatedAt   string     `json:"createdAt"`
	UpdatedAt   string     `json:"updatedAt"`
}

// profilesFile is the databases.json document.
type profilesFile struct {
	Version  int             `json:"version"`
	Profiles []profileRecord `json:"profiles"`
}

func (m *Module) profilesPath() string {
	return filepath.Join(m.dataDir, "databases.json")
}

func (m *Module) keyPath() string {
	return filepath.Join(m.dataDir, "secrets.key")
}

// loadProfiles reads databases.json. A missing file is an empty store; a
// malformed file fails registration so an operator can repair it instead of
// silently losing every profile.
func (m *Module) loadProfiles() error {
	data, err := os.ReadFile(m.profilesPath())
	if err != nil {
		if os.IsNotExist(err) {
			m.profiles = []profileRecord{}
			return nil
		}
		return fmt.Errorf("读取数据库档案失败: %w", err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		m.profiles = []profileRecord{}
		return nil
	}
	var file profilesFile
	if err := json.Unmarshal(data, &file); err != nil {
		return fmt.Errorf("解析数据库档案失败: %w", err)
	}
	if file.Profiles == nil {
		file.Profiles = []profileRecord{}
	}
	m.profiles = file.Profiles
	return nil
}

// saveProfilesLocked atomically writes databases.json. The caller holds m.mu.
func (m *Module) saveProfilesLocked() error {
	file := profilesFile{Version: 1, Profiles: m.profiles}
	if file.Profiles == nil {
		file.Profiles = []profileRecord{}
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(m.profilesPath(), data, 0o600)
}

// encryptionKeyLocked lazily loads or creates the 32-byte AES-256 key stored at
// <dataDir>/secrets.key with mode 0600. The caller holds m.mu.
func (m *Module) encryptionKeyLocked() ([]byte, error) {
	if len(m.key) == 32 {
		return m.key, nil
	}
	path := m.keyPath()
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(data) != 32 {
			return nil, fmt.Errorf("secrets.key 长度必须为 32 字节，当前 %d 字节", len(data))
		}
		m.key = data
		return data, nil
	case os.IsNotExist(err):
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, fmt.Errorf("生成加密密钥失败: %w", err)
		}
		if err := config.WriteFileAtomic(path, key, 0o600); err != nil {
			return nil, fmt.Errorf("写入 secrets.key 失败: %w", err)
		}
		m.key = key
		return key, nil
	default:
		return nil, err
	}
}

// sealPassword encrypts a plaintext profile password.
func (m *Module) sealPassword(password string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key, err := m.encryptionKeyLocked()
	if err != nil {
		return "", err
	}
	sealed, err := auth.Seal(key, password)
	if err != nil {
		return "", fmt.Errorf("加密密码失败: %w", err)
	}
	return sealed, nil
}

// revealPassword decrypts a profile password. An empty PasswordEnc means the
// profile has no password.
func (m *Module) revealPassword(profile profileRecord) (string, error) {
	if profile.PasswordEnc == "" {
		return "", nil
	}
	m.mu.Lock()
	key, err := m.encryptionKeyLocked()
	m.mu.Unlock()
	if err != nil {
		return "", err
	}
	plain, err := auth.Open(key, profile.PasswordEnc)
	if err != nil {
		return "", fmt.Errorf("解密密码失败: %w", err)
	}
	return plain, nil
}

func (p profileRecord) public() DatabaseProfile {
	return DatabaseProfile{
		ID:          p.ID,
		Name:        p.Name,
		Kind:        p.Kind,
		Host:        p.Host,
		Port:        p.Port,
		Username:    p.Username,
		Database:    p.Database,
		TLS:         p.TLS,
		RedisDB:     p.RedisDB,
		HasPassword: p.PasswordEnc != "",
		LastCheck:   p.LastCheck,
		CreatedAt:   p.CreatedAt,
		UpdatedAt:   p.UpdatedAt,
	}
}

// dbName is the database the PostgreSQL tools connect to. When the profile has
// no explicit database we use "postgres", which exists on every stock cluster.
func (p profileRecord) dbName() string {
	if p.Database != nil && strings.TrimSpace(*p.Database) != "" {
		return strings.TrimSpace(*p.Database)
	}
	return "postgres"
}

// usernameValue is a convenience for drivers that take a plain string.
func (p profileRecord) usernameValue() string {
	if p.Username == nil {
		return ""
	}
	return *p.Username
}

// dialHost normalises a user-supplied host for net.JoinHostPort (IPv6 literals
// may arrive wrapped in brackets).
func dialHost(host string) string {
	return strings.Trim(strings.TrimSpace(host), "[]")
}

func defaultPort(kind string) int {
	if kind == kindRedis {
		return 6379
	}
	return 5432
}

func cleanPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func validateProfileName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", protocol.BadRequest("档案名称不能为空")
	}
	if len([]rune(name)) > 128 {
		return "", protocol.BadRequest("档案名称不能超过 128 个字符")
	}
	if strings.ContainsAny(name, "\r\n\x00") {
		return "", protocol.BadRequest("档案名称包含非法字符")
	}
	return name, nil
}

func validateHost(host string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", protocol.BadRequest("主机不能为空")
	}
	if len(host) > 255 {
		return "", protocol.BadRequest("主机名过长")
	}
	if strings.ContainsAny(host, " \t\r\n\x00") {
		return "", protocol.BadRequest("主机名不能包含空白字符")
	}
	return host, nil
}

func validatePort(port int) error {
	if port < 1 || port > 65535 {
		return protocol.BadRequest("端口必须在 1-65535 之间")
	}
	return nil
}

func validateKind(kind string) error {
	if kind != kindPostgres && kind != kindRedis {
		return protocol.BadRequest("kind 只能是 postgres 或 redis")
	}
	return nil
}

func validateRedisDB(redisDB *int) error {
	if redisDB == nil {
		return nil
	}
	if *redisDB < 0 || *redisDB > 15 {
		return protocol.BadRequest("redisDb 必须在 0-15 之间")
	}
	return nil
}

// validateEngineFields enforces the contract rule that database is postgres
// only and redisDb is redis only.
func validateEngineFields(kind string, database *string, redisDB *int) error {
	if kind == kindPostgres {
		if redisDB != nil {
			return protocol.BadRequest("postgres 档案不能设置 redisDb")
		}
		return nil
	}
	if database != nil {
		return protocol.BadRequest("redis 档案不能设置 database")
	}
	return validateRedisDB(redisDB)
}

// createProfile validates and persists a new profile.
func (m *Module) createProfile(in DatabaseProfileCreateInput) (DatabaseProfile, error) {
	if err := validateKind(in.Kind); err != nil {
		return DatabaseProfile{}, err
	}
	name, err := validateProfileName(in.Name)
	if err != nil {
		return DatabaseProfile{}, err
	}
	host, err := validateHost(in.Host)
	if err != nil {
		return DatabaseProfile{}, err
	}
	port := defaultPort(in.Kind)
	if in.Port != nil {
		port = *in.Port
	}
	if err := validatePort(port); err != nil {
		return DatabaseProfile{}, err
	}
	username := cleanPointer(in.Username)
	database := cleanPointer(in.Database)
	redisDB := cleanIntPointer(in.RedisDB)
	if err := validateEngineFields(in.Kind, database, redisDB); err != nil {
		return DatabaseProfile{}, err
	}

	var encrypted string
	if in.Password != nil && *in.Password != "" {
		encrypted, err = m.sealPassword(*in.Password)
		if err != nil {
			return DatabaseProfile{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "无法加密数据库密码"}
		}
	}

	now := nowStamp()
	record := profileRecord{
		ID:          "db_" + protocol.RandomID(9),
		Name:        name,
		Kind:        in.Kind,
		Host:        host,
		Port:        port,
		Username:    username,
		Database:    database,
		TLS:         in.TLS != nil && *in.TLS,
		RedisDB:     redisDB,
		PasswordEnc: encrypted,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.profiles {
		if strings.EqualFold(existing.Name, record.Name) {
			return DatabaseProfile{}, &protocol.PanelError{
				Code:    protocol.CodeConflict,
				Message: "数据库档案名称已存在",
				Details: map[string]any{"resource": "databaseProfile", "field": "name"},
			}
		}
	}
	m.profiles = append(m.profiles, record)
	if err := m.saveProfilesLocked(); err != nil {
		m.profiles = m.profiles[:len(m.profiles)-1]
		return DatabaseProfile{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "保存数据库档案失败"}
	}
	return record.public(), nil
}

// patchProfile applies a partial update. password:null clears it.
func (m *Module) patchProfile(id string, in DatabaseProfileUpdateInput) (DatabaseProfile, error) {
	m.mu.Lock()
	index := -1
	for i := range m.profiles {
		if m.profiles[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		m.mu.Unlock()
		return DatabaseProfile{}, protocol.NotFound("数据库档案", id)
	}
	updated := m.profiles[index]
	m.mu.Unlock()

	if in.Name != nil {
		name, err := validateProfileName(*in.Name)
		if err != nil {
			return DatabaseProfile{}, err
		}
		updated.Name = name
	}
	if in.Host != nil {
		host, err := validateHost(*in.Host)
		if err != nil {
			return DatabaseProfile{}, err
		}
		updated.Host = host
	}
	if in.Port != nil {
		if err := validatePort(*in.Port); err != nil {
			return DatabaseProfile{}, err
		}
		updated.Port = *in.Port
	}
	if in.TLS != nil {
		updated.TLS = *in.TLS
	}
	if in.Username.Set {
		updated.Username = cleanPointer(in.Username.Value)
	}
	if in.Database.Set {
		if updated.Kind == kindRedis {
			if in.Database.Value != nil && strings.TrimSpace(*in.Database.Value) != "" {
				return DatabaseProfile{}, protocol.BadRequest("redis 档案不能设置 database")
			}
		} else {
			updated.Database = cleanPointer(in.Database.Value)
		}
	}
	if in.RedisDB.Set {
		if updated.Kind == kindPostgres && in.RedisDB.Value != nil {
			return DatabaseProfile{}, protocol.BadRequest("postgres 档案不能设置 redisDb")
		}
		if updated.Kind == kindRedis {
			if err := validateRedisDB(in.RedisDB.Value); err != nil {
				return DatabaseProfile{}, err
			}
			updated.RedisDB = cleanIntPointer(in.RedisDB.Value)
		}
	}
	if in.Password.Set {
		if in.Password.Value == nil || *in.Password.Value == "" {
			updated.PasswordEnc = ""
		} else {
			encrypted, err := m.sealPassword(*in.Password.Value)
			if err != nil {
				return DatabaseProfile{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "无法加密数据库密码"}
			}
			updated.PasswordEnc = encrypted
		}
	}
	updated.UpdatedAt = nowStamp()

	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.profiles {
		if m.profiles[i].ID == id {
			if m.nameTakenLocked(updated.Name, id) {
				return DatabaseProfile{}, &protocol.PanelError{
					Code:    protocol.CodeConflict,
					Message: "数据库档案名称已存在",
					Details: map[string]any{"resource": "databaseProfile", "field": "name"},
				}
			}
			m.profiles[i] = updated
			if err := m.saveProfilesLocked(); err != nil {
				return DatabaseProfile{}, &protocol.PanelError{Code: protocol.CodeInternal, Message: "保存数据库档案失败"}
			}
			return updated.public(), nil
		}
	}
	return DatabaseProfile{}, protocol.NotFound("数据库档案", id)
}

func cleanIntPointer(value *int) *int {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

// nameTakenLocked reports whether another profile already uses name.
func (m *Module) nameTakenLocked(name, exceptID string) bool {
	for _, existing := range m.profiles {
		if existing.ID != exceptID && strings.EqualFold(existing.Name, name) {
			return true
		}
	}
	return false
}

// deleteProfile removes a profile. Backups are deliberately retained.
func (m *Module) deleteProfile(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	index := -1
	for i := range m.profiles {
		if m.profiles[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return protocol.NotFound("数据库档案", id)
	}
	if m.activeJobForProfileLocked(id) != "" {
		return &protocol.PanelError{
			Code:    protocol.CodeConflict,
			Message: "该档案存在运行中的作业，请等待完成或失败后再删除",
			Details: map[string]any{"resource": "databaseProfile", "id": id},
		}
	}
	removed := m.profiles[index]
	m.profiles = append(m.profiles[:index], m.profiles[index+1:]...)
	if err := m.saveProfilesLocked(); err != nil {
		m.profiles = append(m.profiles, profileRecord{})
		copy(m.profiles[index+1:], m.profiles[index:])
		m.profiles[index] = removed
		return &protocol.PanelError{Code: protocol.CodeInternal, Message: "保存数据库档案失败"}
	}
	return nil
}

// findProfile returns a copy of the profile.
func (m *Module) findProfile(id string) (profileRecord, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, profile := range m.profiles {
		if profile.ID == id {
			return profile, true
		}
	}
	return profileRecord{}, false
}

// listProfiles returns a name-sorted, filtered copy.
func (m *Module) listProfiles(kind, search string) []profileRecord {
	m.mu.Lock()
	profiles := make([]profileRecord, 0, len(m.profiles))
	for _, profile := range m.profiles {
		if kind != "" && profile.Kind != kind {
			continue
		}
		if search != "" && !profileMatches(profile, search) {
			continue
		}
		profiles = append(profiles, profile)
	}
	m.mu.Unlock()
	sort.SliceStable(profiles, func(i, j int) bool {
		left, right := strings.ToLower(profiles[i].Name), strings.ToLower(profiles[j].Name)
		if left == right {
			return profiles[i].ID < profiles[j].ID
		}
		return left < right
	})
	return profiles
}

func profileMatches(profile profileRecord, search string) bool {
	needle := strings.ToLower(search)
	if strings.Contains(strings.ToLower(profile.Name), needle) ||
		strings.Contains(strings.ToLower(profile.Host), needle) ||
		strings.Contains(strings.ToLower(profile.usernameValue()), needle) {
		return true
	}
	if profile.Database != nil && strings.Contains(strings.ToLower(*profile.Database), needle) {
		return true
	}
	return false
}

// storeLastCheck updates and persists the last connectivity probe.
func (m *Module) storeLastCheck(id string, check lastCheck) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.profiles {
		if m.profiles[i].ID != id {
			continue
		}
		m.profiles[i].LastCheck = &check
		if err := m.saveProfilesLocked(); err != nil {
			m.logWarn("保存 lastCheck 失败", "profileId", id, "error", err.Error())
		}
		return
	}
}

// pgExecutable derives a sibling executable from a configured path, so a
// version-specific pg_dump directory also yields pg_restore.
func deriveSibling(bin, from, to string) string {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return to
	}
	dir, base := filepath.Split(bin)
	lower := strings.ToLower(base)
	if !strings.HasPrefix(lower, strings.ToLower(from)) {
		return to
	}
	suffix := base[len(from):]
	return filepath.Join(dir, to+suffix)
}

// intPtr is a small helper for optional numeric fields.
func intPtr(value int) *int { return &value }

// strPtr is a small helper for optional string fields.
func strPtr(value string) *string { return &value }

// parseInt64 parses an INFO counter, returning 0 on absence.
func parseInt64(value string) int64 {
	parsed, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return 0
	}
	return parsed
}

// int64Ptr returns nil for a missing counter that the contract models as
// nullable.
func int64Ptr(value int64, present bool) *int64 {
	if !present {
		return nil
	}
	copied := value
	return &copied
}

package sites

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// storeVersion is the sites.json schema version.
const storeVersion = 1

// storeState is the on-disk shape of sites.json.
type storeState struct {
	Version       int    `json:"version"`
	ApplyRevision int    `json:"applyRevision"`
	ApplyAt       string `json:"applyAt,omitempty"`
	Sites         []Site `json:"sites"`
}

// Store owns sites.json and serialises all mutations.
type Store struct {
	mu    sync.Mutex
	path  string
	state storeState
}

// UpdateInput is one PATCH/PUT body (at least one field is required).
type UpdateInput struct {
	Name    *string
	Enabled *bool
	Config  *SiteConfig
}

// ApplyRecord is the bookkeeping for one site after an apply attempt.
type ApplyRecord struct {
	SiteID   string
	Revision int
	Hash     string
	OK       bool
	Error    string
}

// OpenStore loads sites.json, creating an empty store when the file is
// missing. A corrupt file is an error: silently discarding drafts is worse.
func OpenStore(path string) (*Store, error) {
	store := &Store{path: path, state: storeState{Version: storeVersion}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &store.state); err != nil {
		return nil, errors.New("解析 sites.json 失败: " + err.Error())
	}
	if store.state.Version == 0 {
		store.state.Version = storeVersion
	}
	if store.state.Sites == nil {
		store.state.Sites = []Site{}
	}
	return store, nil
}

func (s *Store) saveLocked() error {
	s.state.Version = storeVersion
	// Defence in depth: a plaintext basic-auth password must never reach disk,
	// even if a caller forgot to normalise its config.
	for i := range s.state.Sites {
		if auth := s.state.Sites[i].Config.BasicAuth; auth != nil {
			for j := range auth.Users {
				auth.Users[j].Password = ""
			}
		}
	}
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if dir := filepath.Dir(s.path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	return config.WriteFileAtomic(s.path, data, 0o600)
}

// List returns all sites sorted by updatedAt desc, then name.
func (s *Store) List() []Site {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Site, 0, len(s.state.Sites))
	for _, site := range s.state.Sites {
		out = append(out, decorate(cloneSite(site)))
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].UpdatedAt != out[j].UpdatedAt {
			return out[i].UpdatedAt > out[j].UpdatedAt
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// Get returns one site by id.
func (s *Store) Get(id string) (Site, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, site := range s.state.Sites {
		if site.ID == id {
			return decorate(cloneSite(site)), true
		}
	}
	return Site{}, false
}

// Create appends a new site with revision 1.
func (s *Store) Create(name string, enabled bool, cfg SiteConfig) (Site, *protocol.PanelError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.nameTakenLocked(name, "") {
		return Site{}, &protocol.PanelError{
			Code:    protocol.CodeConflict,
			Message: "站点名称已存在",
			Details: map[string]any{"name": name},
		}
	}
	now := nowRFC3339()
	site := Site{
		ID:        newSiteID(s.state.Sites),
		Name:      name,
		Enabled:   enabled,
		Config:    cloneConfig(cfg),
		Revision:  1,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.state.Sites = append(s.state.Sites, site)
	if err := s.saveLocked(); err != nil {
		s.state.Sites = s.state.Sites[:len(s.state.Sites)-1]
		return Site{}, internalError(err)
	}
	return decorate(cloneSite(site)), nil
}

// Update applies a partial update and bumps the site revision.
func (s *Store) Update(id string, input UpdateInput) (Site, *protocol.PanelError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	index := -1
	for i := range s.state.Sites {
		if s.state.Sites[i].ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return Site{}, protocol.NotFound("站点", id)
	}
	site := s.state.Sites[index]
	previous := site
	if input.Name != nil {
		if s.nameTakenLocked(*input.Name, id) {
			return Site{}, &protocol.PanelError{
				Code:    protocol.CodeConflict,
				Message: "站点名称已存在",
				Details: map[string]any{"name": *input.Name},
			}
		}
		site.Name = *input.Name
	}
	if input.Enabled != nil {
		site.Enabled = *input.Enabled
	}
	if input.Config != nil {
		site.Config = cloneConfig(*input.Config)
	}
	site.Revision++
	site.UpdatedAt = nowRFC3339()
	s.state.Sites[index] = site
	if err := s.saveLocked(); err != nil {
		s.state.Sites[index] = previous
		return Site{}, internalError(err)
	}
	return decorate(cloneSite(site)), nil
}

// Delete removes a site draft. The Caddy fragment, if any, is only removed by
// a full apply (contract §6.2).
func (s *Store) Delete(id string) (Site, *protocol.PanelError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Sites {
		if s.state.Sites[i].ID == id {
			site := decorate(cloneSite(s.state.Sites[i]))
			s.state.Sites = append(s.state.Sites[:i], s.state.Sites[i+1:]...)
			if err := s.saveLocked(); err != nil {
				// Keep memory consistent with disk.
				s.state.Sites = append(s.state.Sites, Site{})
				copy(s.state.Sites[i+1:], s.state.Sites[i:])
				s.state.Sites[i] = site
				return Site{}, internalError(err)
			}
			return site, nil
		}
	}
	return Site{}, protocol.NotFound("站点", id)
}

// ReplaceAll atomically replaces every draft (used by import mode=replace).
func (s *Store) ReplaceAll(sites []Site) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := s.state.Sites
	s.state.Sites = make([]Site, 0, len(sites))
	for _, site := range sites {
		s.state.Sites = append(s.state.Sites, cloneSite(site))
	}
	if err := s.saveLocked(); err != nil {
		s.state.Sites = previous
		return err
	}
	return nil
}

// AppendMany adds sites and keeps the existing ones (import mode=merge).
func (s *Store) AppendMany(sites []Site) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := append([]Site(nil), s.state.Sites...)
	for _, site := range sites {
		s.state.Sites = append(s.state.Sites, cloneSite(site))
	}
	if err := s.saveLocked(); err != nil {
		s.state.Sites = previous
		return err
	}
	return nil
}

// ApplyRevision returns the last global apply sequence number.
func (s *Store) ApplyRevision() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.ApplyRevision
}

// NextApplyRevision allocates and persists the next global apply sequence.
func (s *Store) NextApplyRevision() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := s.state.ApplyRevision
	s.state.ApplyRevision++
	if err := s.saveLocked(); err != nil {
		s.state.ApplyRevision = previous
		return 0, err
	}
	return s.state.ApplyRevision, nil
}

// RecordApply writes per-site lastApply/appliedRevision and the global apply
// timestamp in one atomic save.
func (s *Store) RecordApply(revision int, at time.Time, records []ApplyRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := append([]Site(nil), s.state.Sites...)
	byID := make(map[string]ApplyRecord, len(records))
	for _, record := range records {
		byID[record.SiteID] = record
	}
	atText := at.UTC().Format(time.RFC3339)
	for i := range s.state.Sites {
		record, ok := byID[s.state.Sites[i].ID]
		if !ok {
			continue
		}
		last := &SiteLastApply{
			At:            atText,
			OK:            record.OK,
			Revision:      revision,
			CaddyfileHash: record.Hash,
		}
		if !record.OK {
			last.Error = record.Error
		} else {
			applied := record.Revision
			s.state.Sites[i].AppliedRevision = &applied
		}
		s.state.Sites[i].LastApply = last
	}
	s.state.ApplyRevision = revision
	s.state.ApplyAt = atText
	if err := s.saveLocked(); err != nil {
		s.state.Sites = previous
		return err
	}
	return nil
}

func (s *Store) nameTakenLocked(name, exceptID string) bool {
	for _, site := range s.state.Sites {
		if site.ID != exceptID && site.Name == name {
			return true
		}
	}
	return false
}

// newSiteID generates a filesystem-safe id that is not yet in use.
func newSiteID(existing []Site) string {
	for {
		id := "site_" + protocol.RandomID(9)
		taken := false
		for _, site := range existing {
			if site.ID == id {
				taken = true
				break
			}
		}
		if !taken {
			return id
		}
	}
}

func internalError(err error) *protocol.PanelError {
	return &protocol.PanelError{
		Code:    protocol.CodeInternal,
		Message: "无法写入站点存储",
		Details: map[string]any{"error": err.Error()},
	}
}

// ValidSiteName trims and validates a site name. Names never reach a
// Caddyfile, but control characters are rejected to keep JSON/logs sane.
func ValidSiteName(name string) (string, string) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", "name 不能为空"
	}
	if len([]rune(trimmed)) > 100 {
		return "", "name 最多 100 个字符"
	}
	for _, r := range trimmed {
		if r == '\n' || r == '\r' || r < 0x20 || r == 0x7f {
			return "", "name 含控制字符"
		}
	}
	return trimmed, ""
}

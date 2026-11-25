package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/internal/auth"
	"github.com/sakana-1314/mpanel/internal/config"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

// Identity is the persisted reverse-ws / edge credential.
type Identity struct {
	MachineID string `json:"machineId"`
	Secret    string `json:"secret"`
	CoreURL   string `json:"coreUrl"`
	KeyHash   string `json:"keyHash"`
}

// IdentityPath returns the identity file under the agent data dir.
func IdentityPath(cfg *config.Agent) string {
	return filepath.Join(cfg.Agent.DataDir, "identity.json")
}

// ResolveIdentity returns the machine credential for reverse-ws mode. When an
// edge key is configured and no identity exists (or the key changed), it
// enrolls once via POST /api/v1/edge/enroll and persists the result with 0600.
func ResolveIdentity(ctx context.Context, cfg *config.Agent, log *slog.Logger) (Identity, error) {
	if log == nil {
		log = slog.Default()
	}
	path := IdentityPath(cfg)
	keyHash := ""
	if cfg.Agent.EdgeKey != "" {
		keyHash = auth.SHA256Hex(cfg.Agent.EdgeKey)
	}
	if data, err := os.ReadFile(path); err == nil {
		var existing Identity
		if json.Unmarshal(data, &existing) == nil && existing.Secret != "" {
			sameKey := keyHash == "" || existing.KeyHash == keyHash
			sameCore := existing.CoreURL == "" || existing.CoreURL == cfg.Agent.CoreURL
			if sameKey && sameCore {
				return existing, nil
			}
			log.Info("边缘身份过期，重新入网", "reason", "edge key 或 core 地址已变化")
		}
	}
	if cfg.Agent.MachineID != "" && cfg.Agent.MachineSecret != "" {
		return Identity{MachineID: cfg.Agent.MachineID, Secret: cfg.Agent.MachineSecret, CoreURL: cfg.Agent.CoreURL, KeyHash: keyHash}, nil
	}
	if strings.TrimSpace(cfg.Agent.EdgeKey) == "" {
		return Identity{}, errors.New("reverse-ws 模式需要 MPANEL_MACHINE_SECRET，或配置 MPANEL_EDGE_KEY 自助入网")
	}
	base, err := enrollBase(cfg.Agent.CoreURL)
	if err != nil {
		return Identity{}, err
	}
	host, _ := os.Hostname()
	payload, _ := json.Marshal(protocol.EdgeEnrollRequest{
		Key:      cfg.Agent.EdgeKey,
		Name:     host,
		Platform: runtime.GOOS,
		Arch:     runtime.GOARCH,
		Version:  cfg.Agent.Version,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v1/edge/enroll", bytes.NewReader(payload))
	if err != nil {
		return Identity{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Identity{}, errors.New("连接 core 入网失败: " + err.Error())
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return Identity{}, enrollError(resp.StatusCode, body)
	}
	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			Machine struct {
				ID string `json:"id"`
			} `json:"machine"`
			Secret string `json:"secret"`
			WSURL  string `json:"wsUrl"`
		} `json:"data"`
		Error *protocol.APIError `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || !envelope.OK || envelope.Data.Secret == "" {
		return Identity{}, errors.New("core 入网响应无效")
	}
	identity := Identity{
		MachineID: envelope.Data.Machine.ID,
		Secret:    envelope.Data.Secret,
		CoreURL:   cfg.Agent.CoreURL,
		KeyHash:   keyHash,
	}
	data, _ := json.MarshalIndent(identity, "", "  ")
	if err := config.WriteFileAtomic(path, append(data, '\n'), 0o600); err != nil {
		return Identity{}, err
	}
	log.Info("边缘节点入网成功", "machineId", identity.MachineID)
	return identity, nil
}

func enrollBase(coreURL string) (string, error) {
	raw := strings.TrimSpace(coreURL)
	if raw == "" {
		return "", errors.New("未配置 MPANEL_CORE_URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return "", errors.New("MPANEL_CORE_URL 必须是 http(s):// 或 ws(s)://")
	}
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func enrollError(status int, body []byte) error {
	var envelope struct {
		Error *protocol.APIError `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	message := "边缘入网被拒绝"
	if envelope.Error != nil && envelope.Error.Message != "" {
		message = envelope.Error.Message
	}
	hint := "确认 MPANEL_EDGE_KEY 有效、未过期且未用尽"
	if status == http.StatusForbidden {
		hint = "密钥已吊销/过期/次数用尽，或 core 拒绝了本次入网"
	}
	return &protocol.PanelError{Code: protocol.CodeForbidden, Message: message, Hint: hint}
}

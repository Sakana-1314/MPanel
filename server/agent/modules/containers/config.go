package containers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

const (
	defaultDaemonConfigPath = "/etc/docker/daemon.json"
	maxDaemonConfigBytes    = 1 << 20
)

var networkDrivers = map[string]bool{
	"bridge":  true,
	"overlay": true,
	"macvlan": true,
	"ipvlan":  true,
}

var predefinedNetworks = map[string]bool{
	"bridge": true,
	"host":   true,
	"none":   true,
}

/* -------------------------------- networks -------------------------------- */

type networkListEntry struct {
	ID         string `json:"ID"`
	Name       string `json:"Name"`
	Driver     string `json:"Driver"`
	Scope      string `json:"Scope"`
	IPv6       string `json:"IPv6"`
	Internal   string `json:"Internal"`
	Attachable string `json:"Attachable"`
	Labels     string `json:"Labels"`
	CreatedAt  string `json:"CreatedAt"`
}

type networkInspect struct {
	ID         string `json:"Id"`
	Name       string `json:"Name"`
	Created    string `json:"Created"`
	Scope      string `json:"Scope"`
	Driver     string `json:"Driver"`
	EnableIPv6 bool   `json:"EnableIPv6"`
	IPAM       struct {
		Config []struct {
			Subnet  string `json:"Subnet"`
			Gateway string `json:"Gateway"`
			IPRange string `json:"IPRange"`
		} `json:"Config"`
	} `json:"IPAM"`
	Internal   bool              `json:"Internal"`
	Attachable bool              `json:"Attachable"`
	Labels     map[string]string `json:"Labels"`
	Containers map[string]struct {
		Name        string `json:"Name"`
		IPv4Address string `json:"IPv4Address"`
		IPv6Address string `json:"IPv6Address"`
	} `json:"Containers"`
}

func (m *Module) handleListNetworks(w http.ResponseWriter, r *http.Request) {
	limit, cursor, pErr := parsePageQuery(r.URL.Query())
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	available, reason := m.docker.check(r.Context())
	if !available {
		httpapi.OK(w, protocol.UnavailableList[ContainerNetwork](reason))
		return
	}
	res, err := m.docker.run(r.Context(), 30*time.Second, "network", "ls", "--format", "{{json .}}")
	if err != nil {
		httpapi.OK(w, protocol.UnavailableList[ContainerNetwork]("无法执行 docker network ls："+err.Error()))
		return
	}
	if res.Code != 0 {
		if isDockerDaemonUnavailable(res) {
			httpapi.OK(w, protocol.UnavailableList[ContainerNetwork](firstNonEmptyLine(res.Stderr, res.Stdout)))
			return
		}
		httpapi.Fail(w, dockerCommandFailed("network ls", res))
		return
	}
	items := parseNetworkList(res.Stdout)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	httpapi.OK(w, makeListResult(items, limit, cursor))
}

func parseNetworkList(output string) []ContainerNetwork {
	items := make([]ContainerNetwork, 0, 8)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var entry networkListEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil || entry.Name == "" {
			continue
		}
		ipv6, _ := parseBoolValue(entry.IPv6, false)
		internal, _ := parseBoolValue(entry.Internal, false)
		attachable, _ := parseBoolValue(entry.Attachable, false)
		network := ContainerNetwork{
			ID:         entry.ID,
			Name:       entry.Name,
			Driver:     entry.Driver,
			Scope:      entry.Scope,
			Internal:   internal,
			Attachable: attachable,
			IPv6:       ipv6,
			Labels:     parseLabelList(entry.Labels),
		}
		if entry.CreatedAt != "" {
			created := entry.CreatedAt
			network.CreatedAt = &created
		}
		items = append(items, network)
	}
	return items
}

func parseLabelList(raw string) map[string]string {
	labels := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, value, found := strings.Cut(pair, "=")
		if !found || key == "" {
			continue
		}
		labels[key] = value
	}
	return labels
}

func (m *Module) handleGetNetwork(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if !containerRefPattern.MatchString(name) {
		httpapi.Fail(w, protocol.BadRequest("网络名称不合法"))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	detail, pErr := m.inspectNetwork(r.Context(), name)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, detail)
}

func (m *Module) inspectNetwork(ctx context.Context, name string) (ContainerNetworkDetail, *protocol.PanelError) {
	res, err := m.docker.run(ctx, 30*time.Second, "network", "inspect", name)
	if err != nil {
		return ContainerNetworkDetail{}, m.docker.unavailable("无法执行 docker network inspect：" + err.Error())
	}
	if res.Code != 0 {
		if isNoSuchNetworkOutput(res) {
			return ContainerNetworkDetail{}, protocol.NotFound("网络", name)
		}
		return ContainerNetworkDetail{}, dockerCommandFailed("network inspect", res)
	}
	var inspected []networkInspect
	if err := json.Unmarshal([]byte(res.Stdout), &inspected); err != nil || len(inspected) == 0 {
		return ContainerNetworkDetail{}, &protocol.PanelError{
			Code:    protocol.CodeUpstreamError,
			Message: "无法解析 docker network inspect 输出",
			Details: map[string]any{"output": truncateTextString(strings.TrimSpace(res.Stdout), dockerOutputDetails)},
		}
	}
	return networkDetailFromInspect(inspected[0]), nil
}

func networkDetailFromInspect(inspected networkInspect) ContainerNetworkDetail {
	detail := ContainerNetworkDetail{
		ContainerNetwork: ContainerNetwork{
			ID:         inspected.ID,
			Name:       inspected.Name,
			Driver:     inspected.Driver,
			Scope:      inspected.Scope,
			Internal:   inspected.Internal,
			Attachable: inspected.Attachable,
			IPv6:       inspected.EnableIPv6,
			Labels:     inspected.Labels,
		},
		Containers: []ContainerNetworkMember{},
	}
	if detail.Labels == nil {
		detail.Labels = map[string]string{}
	}
	if inspected.Created != "" {
		created := inspected.Created
		detail.CreatedAt = &created
	}
	if len(inspected.IPAM.Config) > 0 {
		cfg := inspected.IPAM.Config[0]
		if cfg.Subnet != "" {
			detail.Subnet = &cfg.Subnet
		}
		if cfg.Gateway != "" {
			detail.Gateway = &cfg.Gateway
		}
		if cfg.IPRange != "" {
			detail.IPRange = &cfg.IPRange
		}
	}
	for id, member := range inspected.Containers {
		detail.Containers = append(detail.Containers, ContainerNetworkMember{
			ID:          id,
			Name:        member.Name,
			IPv4Address: member.IPv4Address,
			IPv6Address: member.IPv6Address,
		})
	}
	sort.SliceStable(detail.Containers, func(i, j int) bool {
		return detail.Containers[i].Name < detail.Containers[j].Name
	})
	return detail
}

func isNoSuchNetworkOutput(res agent.Result) bool {
	text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
	return strings.Contains(text, "no such network") ||
		strings.Contains(text, "not found")
}

func (m *Module) handleCreateNetwork(w http.ResponseWriter, r *http.Request) {
	var input networkCreateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	name := strings.TrimSpace(input.Name)
	if !containerRefPattern.MatchString(name) {
		httpapi.Fail(w, protocol.BadRequest("网络名称需匹配 ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"))
		return
	}
	driver := strings.ToLower(strings.TrimSpace(input.Driver))
	if driver == "" {
		driver = "bridge"
	}
	if !networkDrivers[driver] {
		httpapi.Fail(w, protocol.BadRequest("driver 只允许 bridge、overlay、macvlan、ipvlan"))
		return
	}
	subnet := strings.TrimSpace(input.Subnet)
	gateway := strings.TrimSpace(input.Gateway)
	if subnet != "" {
		_, ipNet, err := net.ParseCIDR(subnet)
		if err != nil {
			httpapi.Fail(w, protocol.BadRequest("subnet 必须是合法 CIDR，例如 172.20.0.0/16"))
			return
		}
		if gateway != "" {
			ip := net.ParseIP(gateway)
			if ip == nil || !ipNet.Contains(ip) {
				httpapi.Fail(w, protocol.BadRequest("gateway 必须是 subnet 内的 IP"))
				return
			}
		}
	} else if gateway != "" {
		httpapi.Fail(w, protocol.BadRequest("填写 gateway 时必须同时填写 subnet"))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}

	args := []string{"network", "create", "--driver", driver}
	if subnet != "" {
		args = append(args, "--subnet", subnet)
	}
	if gateway != "" {
		args = append(args, "--gateway", gateway)
	}
	if input.Internal {
		args = append(args, "--internal")
	}
	if input.Attachable {
		args = append(args, "--attachable")
	}
	args = append(args, name)

	res, err := m.docker.run(r.Context(), 60*time.Second, args...)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker network create："+err.Error()))
		return
	}
	if res.Code != 0 {
		pErr := dockerCommandFailed("network create", res)
		text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
		switch {
		case strings.Contains(text, "already exists"):
			pErr = protocol.Conflict("同名网络已存在")
		case strings.Contains(text, "permission denied"):
			pErr = m.docker.unavailable("没有创建 Docker 网络的权限")
		}
		httpapi.Fail(w, pErr)
		return
	}

	detail, pErr := m.inspectNetwork(r.Context(), name)
	if pErr != nil {
		// The network exists even if inspect raced with a daemon hiccup; return
		// what docker printed rather than failing the creation.
		detail = ContainerNetworkDetail{
			ContainerNetwork: ContainerNetwork{
				ID:         strings.TrimSpace(res.Stdout),
				Name:       name,
				Driver:     driver,
				Scope:      "local",
				Internal:   input.Internal,
				Attachable: input.Attachable,
				Labels:     map[string]string{},
			},
			Containers: []ContainerNetworkMember{},
		}
	}
	httpapi.Created(w, detail)
}

func (m *Module) handleRemoveNetwork(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if !containerRefPattern.MatchString(name) {
		httpapi.Fail(w, protocol.BadRequest("网络名称不合法"))
		return
	}
	if predefinedNetworks[name] {
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "预定义网络不能删除",
			Hint:    "bridge、host、none 由 Docker 维护；请删除自建网络。",
		})
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	res, err := m.docker.run(r.Context(), 60*time.Second, "network", "rm", name)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker network rm："+err.Error()))
		return
	}
	if res.Code != 0 {
		text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
		var pErr *protocol.PanelError
		switch {
		case strings.Contains(text, "no such network"):
			pErr = protocol.NotFound("网络", name)
		case strings.Contains(text, "active endpoints"), strings.Contains(text, "is in use"),
			strings.Contains(text, "has active"):
			pErr = protocol.Conflict("网络仍被容器使用")
			pErr.Hint = "先停止并删除接入该网络的容器，或把它们连接到其它网络。"
		case strings.Contains(text, "pre-defined"):
			pErr = protocol.BadRequest("预定义网络不能删除")
		case strings.Contains(text, "permission denied"):
			pErr = m.docker.unavailable("没有删除 Docker 网络的权限")
		default:
			pErr = dockerCommandFailed("network rm", res)
		}
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, networkRemoveResult{Deleted: true, Name: name})
}

/* ----------------------------- daemon config ------------------------------ */

type daemonFile struct {
	RegistryMirrors    []string `json:"registry-mirrors"`
	InsecureRegistries []string `json:"insecure-registries"`
}

type dockerConfigFile struct {
	Auths map[string]struct {
		Auth     string `json:"auth"`
		Username string `json:"username"`
	} `json:"auths"`
	CredsStore string `json:"credsStore"`
}

func (m *Module) daemonPath() string {
	if strings.TrimSpace(m.daemonConfigPath) != "" {
		return m.daemonConfigPath
	}
	return defaultDaemonConfigPath
}

func (m *Module) handleGetDaemonConfig(w http.ResponseWriter, r *http.Request) {
	config, pErr := m.readDaemonConfig()
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, config)
}

func (m *Module) readDaemonConfig() (ContainerDaemonConfig, *protocol.PanelError) {
	path := m.daemonPath()
	config := ContainerDaemonConfig{
		DaemonPath:         path,
		DaemonJSON:         "{}",
		RegistryMirrors:    []string{},
		InsecureRegistries: []string{},
		Auths:              []RegistryAuth{},
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return config, &protocol.PanelError{
				Code:    protocol.CodeUnavailable,
				Message: "无法读取 Docker daemon 配置",
				Details: map[string]any{"path": path, "reason": err.Error()},
				Hint:    "确认 agent 运行用户对该文件有读权限，或把 agent.docker_config 指向正确路径。",
			}
		}
	} else {
		raw := string(data)
		if strings.TrimSpace(raw) == "" {
			raw = "{}"
		}
		config.DaemonJSON = raw
		var parsed daemonFile
		if json.Unmarshal(data, &parsed) == nil {
			if parsed.RegistryMirrors != nil {
				config.RegistryMirrors = parsed.RegistryMirrors
			}
			if parsed.InsecureRegistries != nil {
				config.InsecureRegistries = parsed.InsecureRegistries
			}
		}
	}

	auths, dockerPath, credsStore := readDockerAuths()
	config.Auths = auths
	if dockerPath != "" {
		config.DockerConfigPath = &dockerPath
	}
	if credsStore != "" {
		config.CredentialStore = &credsStore
	}
	return config, nil
}

func readDockerAuths() ([]RegistryAuth, string, string) {
	auths := []RegistryAuth{}
	path := ""
	if dir := strings.TrimSpace(os.Getenv("DOCKER_CONFIG")); dir != "" {
		path = filepath.Join(dir, "config.json")
	} else if home, err := os.UserHomeDir(); err == nil && home != "" {
		path = filepath.Join(home, ".docker", "config.json")
	}
	if path == "" {
		return auths, "", ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return auths, path, ""
	}
	var parsed dockerConfigFile
	if json.Unmarshal(data, &parsed) != nil || len(parsed.Auths) == 0 {
		return auths, path, parsed.CredsStore
	}
	for registry, entry := range parsed.Auths {
		auths = append(auths, RegistryAuth{
			Registry: registry,
			Username: authUsername(entry.Auth, entry.Username),
		})
	}
	sort.SliceStable(auths, func(i, j int) bool { return auths[i].Registry < auths[j].Registry })
	return auths, path, parsed.CredsStore
}

func authUsername(auth, username string) string {
	if strings.TrimSpace(username) != "" {
		return username
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(auth))
	if err != nil {
		return ""
	}
	user, _, found := strings.Cut(string(decoded), ":")
	if !found {
		return ""
	}
	return user
}

func (m *Module) handleUpdateDaemonConfig(w http.ResponseWriter, r *http.Request) {
	var input daemonConfigInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	raw := input.DaemonJSON
	if strings.TrimSpace(raw) == "" {
		httpapi.Fail(w, protocol.BadRequest("daemonJson 不能为空"))
		return
	}
	if len(raw) > maxDaemonConfigBytes {
		httpapi.Fail(w, protocol.BadRequest("daemonJson 超过 1 MiB 上限"))
		return
	}
	canonical, pErr := validateDaemonJSON(raw)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if pErr := m.writeDaemonConfig(canonical); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	config, pErr := m.readDaemonConfig()
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, config)
}

func validateDaemonJSON(raw string) (string, *protocol.PanelError) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return "", &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "daemonJson 不是合法 JSON 对象",
			Details: map[string]any{"error": err.Error()},
		}
	}
	if document == nil {
		return "", protocol.BadRequest("daemonJson 必须是 JSON 对象")
	}
	for _, key := range []string{"registry-mirrors", "insecure-registries"} {
		value, ok := document[key]
		if !ok {
			continue
		}
		var list []string
		if err := json.Unmarshal(value, &list); err != nil {
			return "", protocol.BadRequest("daemonJson 的 " + key + " 必须是字符串数组")
		}
	}
	for _, key := range []string{"data-root", "log-driver", "storage-driver"} {
		value, ok := document[key]
		if !ok {
			continue
		}
		var text string
		if err := json.Unmarshal(value, &text); err != nil {
			return "", protocol.BadRequest("daemonJson 的 " + key + " 必须是字符串")
		}
	}

	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(raw), "", "  "); err != nil {
		return "", protocol.BadRequest("daemonJson 格式化失败")
	}
	pretty.WriteString("\n")
	return pretty.String(), nil
}

func (m *Module) writeDaemonConfig(content string) *protocol.PanelError {
	path := m.daemonPath()
	if strings.TrimSpace(path) == "" {
		return protocol.BadRequest("docker_config 不能为空")
	}
	clean := filepath.Clean(path)
	if !filepath.IsAbs(clean) {
		return &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "docker_config 必须是绝对路径",
			Details: map[string]any{"path": path},
		}
	}
	if _, err := os.Stat(clean); err == nil {
		if info, lerr := os.Lstat(clean); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
			return protocol.BadRequest("拒绝写入符号链接形式的 daemon.json")
		}
	}
	dir := filepath.Dir(clean)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法创建 Docker 配置目录",
			Details: map[string]any{"path": dir, "reason": err.Error()},
			Hint:    "确认 agent 运行用户对 docker_config 所在目录有写权限。",
		}
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法解析 Docker 配置目录",
			Details: map[string]any{"path": dir, "reason": err.Error()},
		}
	}
	target := filepath.Join(realDir, filepath.Base(clean))
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return protocol.BadRequest("拒绝写入符号链接形式的 daemon.json")
		}
		if info.IsDir() {
			return protocol.BadRequest("daemon.json 路径指向目录")
		}
	}

	tmp, err := os.CreateTemp(realDir, ".daemon.json-*")
	if err != nil {
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法创建临时文件",
			Details: map[string]any{"path": realDir, "reason": err.Error()},
			Hint:    "确认 agent 运行用户对 docker_config 所在目录有写权限。",
		}
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o644); err != nil {
		cleanup()
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法设置 daemon.json 权限",
			Details: map[string]any{"reason": err.Error()},
		}
	}
	if _, err := tmp.WriteString(content); err != nil {
		cleanup()
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法写入 daemon.json",
			Details: map[string]any{"reason": err.Error()},
		}
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法同步 daemon.json",
			Details: map[string]any{"reason": err.Error()},
		}
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法关闭临时文件",
			Details: map[string]any{"reason": err.Error()},
		}
	}
	if err := os.Rename(tmpName, target); err != nil {
		_ = os.Remove(tmpName)
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法替换 daemon.json",
			Details: map[string]any{"path": target, "reason": err.Error()},
			Hint:    "确认 agent 运行用户对 docker_config 所在目录有写权限。",
		}
	}
	return nil
}

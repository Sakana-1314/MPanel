package containers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

const (
	dockerProbeTTL      = 15 * time.Second
	dockerProbeTimeout  = 5 * time.Second
	dockerDefaultBin    = "docker"
	maxTailLines        = 10000
	maxLogBytes         = 1 << 20
	maxComposeBytes     = 1 << 20
	maxExecStreamBytes  = 1 << 20
	maxExecArgs         = 128
	maxExecArgBytes     = 4096
	maxExecTotalBytes   = 64 << 10
	maxExecTimeoutMs    = 300000
	defaultExecTimeout  = 30 * time.Second
	dockerOutputDetails = 64 << 10
)

const (
	labelComposeProject     = "com.docker.compose.project"
	labelComposeService     = "com.docker.compose.service"
	labelComposeWorkingDir  = "com.docker.compose.project.working_dir"
	labelComposeConfigFiles = "com.docker.compose.project.config_files"
)

const dockerInstallHint = "请安装 Docker Engine 与 Docker Compose v2 插件，确认 docker 守护进程正在运行；如 docker 不在 PATH 中，可设置 MPANEL_DOCKER_BIN 指向 docker 可执行文件后重试。"

const composeInstallHint = "请安装 Docker Compose v2 插件（执行 docker compose version 应成功），必要时升级 Docker CLI 后重试。"

var (
	containerRefPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
	stackNamePattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	imageRefPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,511}$`)
	sincePattern        = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z:._+-]{0,63}$`)
	userPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$`)
	winReservedNames    = map[string]bool{
		"con": true, "prn": true, "aux": true, "nul": true,
		"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
		"com6": true, "com7": true, "com8": true, "com9": true,
		"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
		"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
	}
	containerStatuses = map[string]bool{
		"created": true, "restarting": true, "running": true, "removing": true,
		"paused": true, "exited": true, "dead": true,
	}
)

// dockerClient runs the docker CLI through the shared Runner. It never builds a
// shell command line: every argument is passed as an argv element.
type dockerClient struct {
	runner agent.Runner
	bin    string

	mu        sync.Mutex
	checked   time.Time
	available bool
	reason    string
	ttl       time.Duration

	probeMu sync.Mutex
}

func newDockerClient(runner agent.Runner, bin string) *dockerClient {
	if strings.TrimSpace(bin) == "" {
		bin = dockerDefaultBin
	}
	return &dockerClient{runner: runner, bin: bin, ttl: dockerProbeTTL}
}

func (d *dockerClient) run(ctx context.Context, timeout time.Duration, args ...string) (agent.Result, error) {
	return d.runner.RunTimeout(ctx, timeout, d.bin, args...)
}

// check probes "docker version" and caches the result for a short TTL. A
// missing CLI and a stopped daemon are both reported as unavailable.
func (d *dockerClient) check(ctx context.Context) (bool, string) {
	if d == nil || d.runner == nil {
		return false, "Docker 命令执行器未初始化"
	}
	d.mu.Lock()
	if !d.checked.IsZero() && time.Since(d.checked) < d.ttl {
		avail, reason := d.available, d.reason
		d.mu.Unlock()
		return avail, reason
	}
	d.mu.Unlock()

	d.probeMu.Lock()
	defer d.probeMu.Unlock()

	// Another request may have refreshed the cache while we waited.
	d.mu.Lock()
	if !d.checked.IsZero() && time.Since(d.checked) < d.ttl {
		avail, reason := d.available, d.reason
		d.mu.Unlock()
		return avail, reason
	}
	d.mu.Unlock()

	// The probe uses its own deadline: a canceled request must not poison the
	// capability cache for the next caller.
	probeCtx, cancel := context.WithTimeout(context.Background(), dockerProbeTimeout)
	defer cancel()
	res, err := d.runner.RunTimeout(probeCtx, dockerProbeTimeout, d.bin, "version")

	available := false
	var reason string
	switch {
	case err != nil:
		reason = "未找到 docker：" + err.Error()
	case res.Code != 0:
		msg := firstNonEmptyLine(res.Stderr, res.Stdout)
		if msg == "" {
			msg = "docker version 退出码 " + strconv.Itoa(res.Code)
		}
		reason = "docker 不可用：" + msg
	default:
		available = true
	}

	d.mu.Lock()
	d.checked = time.Now()
	d.available = available
	d.reason = reason
	d.mu.Unlock()
	return available, reason
}

func panelErrorReason(pErr *protocol.PanelError) string {
	if pErr == nil {
		return "docker CLI 或守护进程不可用"
	}
	if pErr.Details != nil {
		if reason, ok := pErr.Details["reason"].(string); ok && strings.TrimSpace(reason) != "" {
			return reason
		}
	}
	if strings.TrimSpace(pErr.Message) != "" {
		return pErr.Message
	}
	return "docker CLI 或守护进程不可用"
}

func (d *dockerClient) ensure(ctx context.Context) *protocol.PanelError {
	available, reason := d.check(ctx)
	if available {
		return nil
	}
	return d.unavailable(reason)
}

func (d *dockerClient) unavailable(reason string) *protocol.PanelError {
	if strings.TrimSpace(reason) == "" {
		reason = "docker CLI 或守护进程不可用"
	}
	return &protocol.PanelError{
		Code:    protocol.CodeUnavailable,
		Message: "Docker 不可用",
		Details: map[string]any{"reason": reason},
		Hint:    dockerInstallHint,
	}
}

func (d *dockerClient) invalidate() {
	d.mu.Lock()
	d.checked = time.Time{}
	d.mu.Unlock()
}

/* ------------------------------ command errors ---------------------------- */

func dockerCommandFailed(action string, res agent.Result) *protocol.PanelError {
	output := strings.TrimSpace(res.Stderr)
	if output == "" {
		output = strings.TrimSpace(res.Stdout)
	}
	if isDockerDaemonUnavailable(res) {
		reason := firstNonEmptyLine(res.Stderr, res.Stdout)
		if reason == "" {
			reason = "docker " + action + " 无法连接守护进程"
		}
		return &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "Docker 不可用",
			Details: map[string]any{"reason": reason},
			Hint:    dockerInstallHint,
		}
	}
	return &protocol.PanelError{
		Code:    protocol.CodeUpstreamError,
		Message: "docker " + action + " 失败",
		Details: map[string]any{
			"exitCode": res.Code,
			"output":   truncateTextString(output, dockerOutputDetails),
		},
	}
}

// isDockerDaemonUnavailable recognises both "CLI present but daemon is down"
// and socket permission failures. The capability probe normally catches these
// first, but a daemon can stop between the probe (15s cache) and the command.
func isDockerDaemonUnavailable(res agent.Result) bool {
	text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
	needles := []string{
		"cannot connect to the docker daemon",
		"is the docker daemon running",
		"error during connect",
		"docker daemon is not running",
		"failed to connect to the docker api",
		"permission denied while trying to connect",
		"got permission denied while trying to connect",
	}
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}

func composeUnavailable(res agent.Result) *protocol.PanelError {
	output := firstNonEmptyLine(res.Stderr, res.Stdout)
	if output == "" {
		output = "docker compose 不可用"
	}
	return &protocol.PanelError{
		Code:    protocol.CodeUnavailable,
		Message: "Docker Compose 不可用",
		Details: map[string]any{"reason": output},
		Hint:    composeInstallHint,
	}
}

func isNoSuchContainerOutput(res agent.Result) bool {
	text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
	return strings.Contains(text, "no such container") ||
		strings.Contains(text, "no such object") ||
		strings.Contains(text, "no such id")
}

func isNoSuchImageOutput(res agent.Result) bool {
	text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
	return strings.Contains(text, "no such image") ||
		strings.Contains(text, "no such object") ||
		strings.Contains(text, "no such id")
}

func isComposeMissing(res agent.Result) bool {
	text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
	return strings.Contains(text, "is not a docker command") ||
		strings.Contains(text, "unknown command \"compose\"") ||
		strings.Contains(text, "unknown shorthand flag") && strings.Contains(text, "compose")
}

/* --------------------------------- helpers -------------------------------- */

func firstNonEmptyLine(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if idx := strings.IndexByte(trimmed, '\n'); idx >= 0 {
			trimmed = trimmed[:idx]
		}
		trimmed = strings.TrimSpace(trimmed)
		if len(trimmed) > 300 {
			trimmed = trimmed[:300]
		}
		return trimmed
	}
	return ""
}

func truncateText(s string, max int) (result string, truncated bool) {
	if len(s) <= max {
		return s, false
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

func truncateTextString(s string, max int) string {
	out, _ := truncateText(s, max)
	return out
}

func hasControlChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func validContainerRef(id string) bool {
	return containerRefPattern.MatchString(id)
}

func validStackName(name string) bool {
	if !stackNamePattern.MatchString(name) {
		return false
	}
	return !winReservedNames[strings.ToLower(name)]
}

func validImageRef(ref string) bool {
	if ref == "" || ref != strings.TrimSpace(ref) || strings.HasPrefix(ref, "-") {
		return false
	}
	if hasControlChars(ref) {
		return false
	}
	return imageRefPattern.MatchString(ref)
}

func validSince(value string) bool {
	return sincePattern.MatchString(value)
}

func parseBoolValue(raw string, fallback bool) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return fallback, true
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	default:
		return fallback, false
	}
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

/* ------------------------------- JSON lines ------------------------------- */

// scanJSONLines walks docker's JSON-lines output with a bounded scanner. Blank
// lines are ignored; callers decide how to treat decoding failures.
func scanJSONLines(data string, fn func(line []byte)) {
	scanner := bufio.NewScanner(strings.NewReader(data))
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		fn(line)
	}
}

/* -------------------------------- time ----------------------------------- */

func parseDockerTime(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	layouts := []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05 -0700",
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, true
		}
	}
	if n, err := strconv.ParseInt(value, 10, 64); err == nil && n > 0 {
		if n > 1_000_000_000_000 {
			return time.UnixMilli(n), true
		}
		return time.Unix(n, 0), true
	}
	return time.Time{}, false
}

func normalizeDockerTime(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if parsed, ok := parseDockerTime(value); ok {
		return parsed.UTC().Format(time.RFC3339)
	}
	return value
}

func shortDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

/* --------------------------------- sizes --------------------------------- */

func parseDockerSize(value string) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	lower := strings.ToLower(value)
	if lower == "n/a" || lower == "--" || lower == "0b" {
		return 0
	}
	idx := 0
	for idx < len(value) {
		c := value[idx]
		if (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '+' {
			idx++
			continue
		}
		break
	}
	if idx == 0 {
		return 0
	}
	number, err := strconv.ParseFloat(value[:idx], 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0
	}
	unit := strings.TrimSpace(strings.ToLower(value[idx:]))
	multiplier := float64(1)
	switch unit {
	case "", "b", "bytes":
		multiplier = 1
	case "k", "kb":
		multiplier = 1e3
	case "m", "mb":
		multiplier = 1e6
	case "g", "gb":
		multiplier = 1e9
	case "t", "tb":
		multiplier = 1e12
	case "p", "pb":
		multiplier = 1e15
	case "kib":
		multiplier = 1 << 10
	case "mib":
		multiplier = 1 << 20
	case "gib":
		multiplier = 1 << 30
	case "tib":
		multiplier = 1 << 40
	case "pib":
		multiplier = 1 << 50
	default:
		return 0
	}
	bytes := number * multiplier
	if bytes >= math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(bytes + 0.5)
}

func parseSizePair(value string) (int64, int64) {
	left, right, ok := strings.Cut(value, "/")
	if !ok {
		return parseDockerSize(value), 0
	}
	return parseDockerSize(left), parseDockerSize(right)
}

func parsePercent(value string) float64 {
	value = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(value), "%"))
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0
	}
	return math.Round(number*100) / 100
}

/* --------------------------------- ports --------------------------------- */

func validPortProto(proto string) bool {
	switch strings.ToLower(strings.TrimSpace(proto)) {
	case "tcp", "udp", "sctp":
		return true
	default:
		return false
	}
}

func firstPortNumber(value string) (int, bool) {
	value = strings.TrimSpace(value)
	if idx := strings.IndexByte(value, '-'); idx >= 0 {
		value = value[:idx]
	}
	number, err := strconv.Atoi(value)
	if err != nil || number <= 0 || number > 65535 {
		return 0, false
	}
	return number, true
}

func splitPortProto(value string) (port, proto string) {
	value = strings.TrimSpace(value)
	if idx := strings.LastIndexByte(value, '/'); idx >= 0 {
		return value[:idx], strings.ToLower(strings.TrimSpace(value[idx+1:]))
	}
	return value, "tcp"
}

func dedupePorts(ports []ContainerPort) []ContainerPort {
	seen := make(map[string]bool, len(ports))
	out := make([]ContainerPort, 0, len(ports))
	for _, port := range ports {
		key := fmt.Sprintf("%s|%d|%s|%d", port.IP, port.PrivatePort, port.Type, portPublicValue(port))
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, port)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].PrivatePort != out[j].PrivatePort {
			return out[i].PrivatePort < out[j].PrivatePort
		}
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		if portPublicValue(out[i]) != portPublicValue(out[j]) {
			return portPublicValue(out[i]) < portPublicValue(out[j])
		}
		return out[i].IP < out[j].IP
	})
	return out
}

func portPublicValue(port ContainerPort) int {
	if port.PublicPort == nil {
		return -1
	}
	return *port.PublicPort
}

func parsePortEntry(entry string) (ContainerPort, bool) {
	entry = strings.TrimSpace(entry)
	if entry == "" {
		return ContainerPort{}, false
	}
	left, right, hasArrow := strings.Cut(entry, "->")
	var result ContainerPort
	portPart := left
	if hasArrow {
		portPart = right
		hostPart := strings.TrimSpace(left)
		if hostPart != "" {
			if idx := strings.LastIndexByte(hostPart, ':'); idx >= 0 {
				ip := strings.Trim(strings.TrimSpace(hostPart[:idx]), "[]")
				if ip != "" {
					result.IP = ip
				}
				if public, ok := firstPortNumber(hostPart[idx+1:]); ok {
					result.PublicPort = &public
				}
			} else if public, ok := firstPortNumber(hostPart); ok {
				result.PublicPort = &public
			}
		}
	}
	portText, proto := splitPortProto(portPart)
	if proto == "" {
		proto = "tcp"
	}
	if !validPortProto(proto) {
		return ContainerPort{}, false
	}
	privatePort, ok := firstPortNumber(portText)
	if !ok {
		return ContainerPort{}, false
	}
	result.PrivatePort = privatePort
	result.Type = proto
	return result, true
}

func parsePortsString(value string) []ContainerPort {
	ports := make([]ContainerPort, 0)
	if strings.TrimSpace(value) == "" {
		return ports
	}
	for _, entry := range strings.Split(value, ",") {
		if port, ok := parsePortEntry(entry); ok {
			ports = append(ports, port)
		}
	}
	return dedupePorts(ports)
}

func parsePortKey(key string) (int, string, bool) {
	portText, proto := splitPortProto(key)
	if proto == "" {
		proto = "tcp"
	}
	if !validPortProto(proto) {
		return 0, "", false
	}
	port, ok := firstPortNumber(portText)
	if !ok {
		return 0, "", false
	}
	return port, proto, true
}

/* -------------------------------- labels --------------------------------- */

func parseLabelsString(raw string) map[string]string {
	labels := make(map[string]string)
	if strings.TrimSpace(raw) == "" {
		return labels
	}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		key, value, ok := strings.Cut(entry, "=")
		if !ok || strings.TrimSpace(key) == "" {
			continue
		}
		labels[strings.TrimSpace(key)] = value
	}
	return labels
}

func copyLabels(labels map[string]string) map[string]string {
	out := make(map[string]string, len(labels))
	for key, value := range labels {
		out[key] = value
	}
	return out
}

func composeValue(labels map[string]string, key string) *string {
	value, ok := labels[key]
	if !ok || strings.TrimSpace(value) == "" {
		return nil
	}
	copied := value
	return &copied
}

func splitNameList(raw string) []string {
	names := make([]string, 0, 1)
	for _, name := range strings.Split(raw, ",") {
		name = strings.TrimSpace(name)
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names
}

/* ------------------------------- containers ------------------------------- */

// psContainer mirrors the JSON object emitted by docker ps --format json.
// Docker has changed fields across versions, so every field is optional.
type psContainer struct {
	ID         string `json:"ID"`
	Names      string `json:"Names"`
	Image      string `json:"Image"`
	ImageID    string `json:"ImageID"`
	Command    string `json:"Command"`
	CreatedAt  string `json:"CreatedAt"`
	RunningFor string `json:"RunningFor"`
	Ports      string `json:"Ports"`
	State      string `json:"State"`
	Status     string `json:"Status"`
	Labels     string `json:"Labels"`
	Mounts     string `json:"Mounts"`
	Networks   string `json:"Networks"`
}

func containerFromPS(raw psContainer) ContainerSummary {
	labels := parseLabelsString(raw.Labels)
	names := splitNameList(raw.Names)
	summary := ContainerSummary{
		ID:             strings.TrimSpace(raw.ID),
		Names:          names,
		Image:          raw.Image,
		ImageID:        raw.ImageID,
		Command:        raw.Command,
		Created:        normalizeDockerTime(raw.CreatedAt),
		State:          raw.State,
		Status:         raw.Status,
		Ports:          parsePortsString(raw.Ports),
		Labels:         labels,
		ComposeProject: composeValue(labels, labelComposeProject),
		ComposeService: composeValue(labels, labelComposeService),
	}
	if summary.Names == nil {
		summary.Names = []string{}
	}
	if summary.Ports == nil {
		summary.Ports = []ContainerPort{}
	}
	return summary
}

func parseContainerSummaries(stdout string) []ContainerSummary {
	containers := make([]ContainerSummary, 0)
	scanJSONLines(stdout, func(line []byte) {
		var raw psContainer
		if err := json.Unmarshal(line, &raw); err != nil {
			return
		}
		if strings.TrimSpace(raw.ID) == "" && strings.TrimSpace(raw.Names) == "" {
			return
		}
		containers = append(containers, containerFromPS(raw))
	})
	sortContainerSummaries(containers)
	return containers
}

func sortContainerSummaries(containers []ContainerSummary) {
	sort.SliceStable(containers, func(i, j int) bool {
		left, leftOK := parseDockerTime(containers[i].Created)
		right, rightOK := parseDockerTime(containers[j].Created)
		if leftOK && rightOK && !left.Equal(right) {
			return left.After(right)
		}
		if leftOK != rightOK {
			return leftOK
		}
		return containers[i].ID < containers[j].ID
	})
}

type inspectPortBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

type inspectMount struct {
	Type        string `json:"Type"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	Mode        string `json:"Mode"`
	RW          bool   `json:"RW"`
}

type inspectContainer struct {
	ID       string `json:"Id"`
	Name     string `json:"Name"`
	Image    string `json:"Image"`
	Created  string `json:"Created"`
	Platform string `json:"Platform"`
	Config   struct {
		Image        string                     `json:"Image"`
		Cmd          []string                   `json:"Cmd"`
		Entrypoint   []string                   `json:"Entrypoint"`
		Env          []string                   `json:"Env"`
		Labels       map[string]string          `json:"Labels"`
		ExposedPorts map[string]json.RawMessage `json:"ExposedPorts"`
	} `json:"Config"`
	State struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		ExitCode   int    `json:"ExitCode"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	HostConfig struct {
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
		NetworkMode string `json:"NetworkMode"`
	} `json:"HostConfig"`
	Mounts          []inspectMount `json:"Mounts"`
	NetworkSettings struct {
		Ports map[string][]inspectPortBinding `json:"Ports"`
	} `json:"NetworkSettings"`
}

func parseInspectContainers(data string) ([]inspectContainer, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return nil, errors.New("docker inspect 输出为空")
	}
	var list []inspectContainer
	if err := json.Unmarshal([]byte(data), &list); err == nil {
		return list, nil
	}
	var single inspectContainer
	if err := json.Unmarshal([]byte(data), &single); err == nil && single.ID != "" {
		return []inspectContainer{single}, nil
	}
	return nil, errors.New("无法解析 docker inspect 输出")
}

func healthStatus(c inspectContainer) string {
	if c.State.Health == nil {
		return ""
	}
	return strings.TrimSpace(c.State.Health.Status)
}

func containerStatusText(c inspectContainer) string {
	state := strings.TrimSpace(c.State.Status)
	if state == "" {
		if c.State.Running {
			state = "running"
		} else {
			state = "unknown"
		}
	}
	switch state {
	case "running":
		text := "running"
		if started, ok := parseDockerTime(c.State.StartedAt); ok {
			text = "Up " + shortDuration(time.Since(started))
		}
		if health := healthStatus(c); health != "" {
			text += " (" + health + ")"
		}
		return text
	case "exited":
		text := fmt.Sprintf("exited (%d)", c.State.ExitCode)
		if finished, ok := parseDockerTime(c.State.FinishedAt); ok && !finished.IsZero() {
			text += " " + shortDuration(time.Since(finished)) + " ago"
		}
		return text
	default:
		return state
	}
}

func portsFromInspect(c inspectContainer) []ContainerPort {
	ports := make([]ContainerPort, 0)
	for key, bindings := range c.NetworkSettings.Ports {
		privatePort, proto, ok := parsePortKey(key)
		if !ok {
			continue
		}
		if len(bindings) == 0 {
			ports = append(ports, ContainerPort{PrivatePort: privatePort, Type: proto})
			continue
		}
		for _, binding := range bindings {
			port := ContainerPort{
				IP:          strings.Trim(strings.TrimSpace(binding.HostIP), "[]"),
				PrivatePort: privatePort,
				Type:        proto,
			}
			if public, ok := firstPortNumber(binding.HostPort); ok {
				port.PublicPort = &public
			}
			ports = append(ports, port)
		}
	}
	// Exposed-but-unpublished ports do not always appear in NetworkSettings.
	for key := range c.Config.ExposedPorts {
		privatePort, proto, ok := parsePortKey(key)
		if !ok {
			continue
		}
		found := false
		for _, existing := range ports {
			if existing.PrivatePort == privatePort && existing.Type == proto {
				found = true
				break
			}
		}
		if !found {
			ports = append(ports, ContainerPort{PrivatePort: privatePort, Type: proto})
		}
	}
	return dedupePorts(ports)
}

func detailFromInspect(c inspectContainer) ContainerDetail {
	labels := copyLabels(c.Config.Labels)
	imageRef := c.Config.Image
	if imageRef == "" {
		imageRef = c.Image
	}
	command := strings.Join(c.Config.Cmd, " ")
	if command == "" {
		command = strings.Join(c.Config.Entrypoint, " ")
	}
	names := []string{}
	if name := strings.TrimPrefix(strings.TrimSpace(c.Name), "/"); name != "" {
		names = append(names, name)
	}
	state := strings.TrimSpace(c.State.Status)
	if state == "" {
		if c.State.Running {
			state = "running"
		} else {
			state = "unknown"
		}
	}
	summary := ContainerSummary{
		ID:             c.ID,
		Names:          names,
		Image:          imageRef,
		ImageID:        c.Image,
		Command:        command,
		Created:        normalizeDockerTime(c.Created),
		State:          state,
		Status:         containerStatusText(c),
		Ports:          portsFromInspect(c),
		Labels:         labels,
		ComposeProject: composeValue(labels, labelComposeProject),
		ComposeService: composeValue(labels, labelComposeService),
	}
	env := append([]string{}, c.Config.Env...)
	if env == nil {
		env = []string{}
	}
	mounts := make([]ContainerMount, 0, len(c.Mounts))
	for _, mount := range c.Mounts {
		mounts = append(mounts, ContainerMount{
			Type:        mount.Type,
			Source:      mount.Source,
			Destination: mount.Destination,
			Mode:        mount.Mode,
			RW:          mount.RW,
		})
	}
	var health *string
	if status := healthStatus(c); status != "" {
		copied := status
		health = &copied
	}
	return ContainerDetail{
		ContainerSummary: summary,
		Env:              env,
		Mounts:           mounts,
		RestartPolicy:    c.HostConfig.RestartPolicy.Name,
		Platform:         c.Platform,
		NetworkMode:      c.HostConfig.NetworkMode,
		Health:           health,
	}
}

func (d *dockerClient) listContainers(ctx context.Context, all bool, status string) ([]ContainerSummary, *protocol.PanelError) {
	args := []string{"ps"}
	if all {
		args = append(args, "-a")
	}
	args = append(args, "--no-trunc", "--format", "json")
	if status != "" {
		args = append(args, "--filter", "status="+status)
	}
	res, err := d.run(ctx, 60*time.Second, args...)
	if err != nil {
		return nil, d.unavailable("无法执行 docker ps：" + err.Error())
	}
	if res.Code != 0 {
		reason := firstNonEmptyLine(res.Stderr, res.Stdout)
		if reason == "" {
			reason = "docker ps 退出码 " + strconv.Itoa(res.Code)
		}
		return nil, &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法读取容器列表",
			Details: map[string]any{"reason": reason},
			Hint:    dockerInstallHint,
		}
	}
	return parseContainerSummaries(res.Stdout), nil
}

func (d *dockerClient) inspectContainer(ctx context.Context, id string) (ContainerDetail, *protocol.PanelError) {
	res, err := d.run(ctx, 30*time.Second, "inspect", "--type", "container", id)
	if err != nil {
		return ContainerDetail{}, d.unavailable("无法执行 docker inspect：" + err.Error())
	}
	if res.Code != 0 {
		if isNoSuchContainerOutput(res) {
			return ContainerDetail{}, protocol.NotFound("容器", id)
		}
		return ContainerDetail{}, dockerCommandFailed("inspect", res)
	}
	list, err := parseInspectContainers(res.Stdout)
	if err != nil {
		return ContainerDetail{}, &protocol.PanelError{
			Code:    protocol.CodeUpstreamError,
			Message: "无法解析 docker inspect 输出",
			Details: map[string]any{"error": err.Error()},
		}
	}
	if len(list) == 0 {
		return ContainerDetail{}, protocol.NotFound("容器", id)
	}
	return detailFromInspect(list[0]), nil
}

/* --------------------------------- stats --------------------------------- */

type statsRaw struct {
	Container string `json:"Container"`
	ID        string `json:"ID"`
	Name      string `json:"Name"`
	CPUPerc   string `json:"CPUPerc"`
	MemUsage  string `json:"MemUsage"`
	MemPerc   string `json:"MemPerc"`
	NetIO     string `json:"NetIO"`
	BlockIO   string `json:"BlockIO"`
	PIDs      string `json:"PIDs"`
}

func parseStatsOutput(stdout string) (ContainerStats, bool) {
	var last *statsRaw
	scanJSONLines(stdout, func(line []byte) {
		var raw statsRaw
		if err := json.Unmarshal(line, &raw); err != nil {
			return
		}
		if raw.CPUPerc == "" && raw.MemUsage == "" && raw.NetIO == "" && raw.ID == "" && raw.Container == "" {
			return
		}
		copied := raw
		last = &copied
	})
	if last == nil {
		return ContainerStats{}, false
	}
	memoryUsage, memoryLimit := parseSizePair(last.MemUsage)
	networkRx, networkTx := parseSizePair(last.NetIO)
	blockRead, blockWrite := parseSizePair(last.BlockIO)
	memoryPercent := parsePercent(last.MemPerc)
	if memoryPercent == 0 && memoryLimit > 0 && memoryUsage > 0 {
		memoryPercent = math.Round(float64(memoryUsage)/float64(memoryLimit)*10000) / 100
	}
	pids := 0
	if trimmed := strings.TrimSpace(last.PIDs); trimmed != "" {
		if parsed, err := strconv.Atoi(trimmed); err == nil && parsed >= 0 {
			pids = parsed
		}
	}
	return ContainerStats{
		CPUPercent:       parsePercent(last.CPUPerc),
		MemoryUsageBytes: memoryUsage,
		MemoryLimitBytes: memoryLimit,
		MemoryPercent:    memoryPercent,
		NetworkRxBytes:   networkRx,
		NetworkTxBytes:   networkTx,
		BlockReadBytes:   blockRead,
		BlockWriteBytes:  blockWrite,
		PIDs:             pids,
		ReadAt:           time.Now().UTC().Format(time.RFC3339),
	}, true
}

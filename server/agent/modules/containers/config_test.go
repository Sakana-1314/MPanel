package containers

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/config"
)

func newConfigTestEnv(t *testing.T, daemonPath string, handler func(args []string) (agent.Result, error)) *testEnv {
	t.Helper()
	dataDir := t.TempDir()
	runner := &fakeRunner{handler: handler}
	cfg := &config.Agent{Agent: config.AgentSystem{
		DockerBin:    "docker",
		DockerConfig: daemonPath,
		DataDir:      dataDir,
	}}
	ctx := &agent.Context{
		Mux:    http.NewServeMux(),
		WS:     agent.NewWSRegistry(),
		Cfg:    cfg,
		Runner: runner,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	module := New()
	if err := module.Register(ctx); err != nil {
		t.Fatalf("Register: %v", err)
	}
	return &testEnv{module: module, handler: ctx.Mux, runner: runner, dataDir: dataDir}
}

func dockerOK(args []string) (agent.Result, error) {
	joined := strings.Join(args, " ")
	switch {
	case joined == "version":
		return agent.Result{Code: 0}, nil
	case joined == "network ls --format {{json .}}":
		return agent.Result{Code: 0, Stdout: strings.Join([]string{
			`{"ID":"net1","Name":"mpanel-net","Driver":"bridge","Scope":"local","IPv6":"false","Internal":"true","Labels":"team=infra"}`,
			`{"ID":"net2","Name":"bridge","Driver":"bridge","Scope":"local","IPv6":"false","Internal":"false","Labels":""}`,
		}, "\n") + "\n"}, nil
	case joined == "network inspect mpanel-net":
		return agent.Result{Code: 0, Stdout: `[{"Name":"mpanel-net","Id":"net1","Created":"2026-01-01T00:00:00Z","Scope":"local","Driver":"bridge","EnableIPv6":false,"IPAM":{"Config":[{"Subnet":"172.20.0.0/16","Gateway":"172.20.0.1"}]},"Internal":true,"Attachable":true,"Labels":{"team":"infra"},"Containers":{"abc":{"Name":"web","IPv4Address":"172.20.0.2/16"}}}]`}, nil
	case strings.HasPrefix(joined, "network create "):
		return agent.Result{Code: 0, Stdout: "net3\n"}, nil
	case joined == "network rm mpanel-net":
		return agent.Result{Code: 0, Stdout: "mpanel-net\n"}, nil
	case joined == "network rm busy-net":
		return agent.Result{Code: 1, Stderr: "Error response from daemon: network busy-net has active endpoints"}, nil
	}
	return agent.Result{Code: 0}, nil
}

func TestNetworkEndpoints(t *testing.T) {
	env := newConfigTestEnv(t, filepath.Join(t.TempDir(), "daemon.json"), dockerOK)

	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/networks", "")
	if status != 200 || !envelope.OK {
		t.Fatalf("list status=%d error=%+v", status, envelope.Error)
	}
	list := decodeData[struct {
		Available bool               `json:"available"`
		Items     []ContainerNetwork `json:"items"`
	}](t, envelope.Data)
	if !list.Available || len(list.Items) != 2 {
		t.Fatalf("unexpected list: %+v", list)
	}
	if list.Items[0].Name != "bridge" || list.Items[1].Name != "mpanel-net" {
		t.Fatalf("list order: %+v", list.Items)
	}
	if list.Items[1].Labels["team"] != "infra" || !list.Items[1].Internal {
		t.Fatalf("labels/internal: %+v", list.Items[1])
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/networks/mpanel-net/inspect", "")
	if status != 200 || !envelope.OK {
		t.Fatalf("detail status=%d error=%+v", status, envelope.Error)
	}
	detail := decodeData[ContainerNetworkDetail](t, envelope.Data)
	if detail.Subnet == nil || *detail.Subnet != "172.20.0.0/16" || len(detail.Containers) != 1 {
		t.Fatalf("unexpected detail: %+v", detail)
	}

	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/networks",
		`{"name":"mpanel-net","driver":"bridge","subnet":"172.20.0.0/16","gateway":"172.20.0.1","internal":true}`)
	if status != 201 || !envelope.OK {
		t.Fatalf("create status=%d error=%+v", status, envelope.Error)
	}
	var createCall []string
	env.runner.mu.Lock()
	for _, call := range env.runner.calls {
		if len(call) > 1 && call[0] == "network" && call[1] == "create" {
			createCall = call
		}
	}
	env.runner.mu.Unlock()
	if len(createCall) < 6 {
		t.Fatalf("create call: %+v", createCall)
	}

	status, _ = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/networks",
		`{"name":"bad net"}`)
	if status != 400 {
		t.Fatalf("invalid name status=%d", status)
	}
	status, _ = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/networks",
		`{"name":"bad-driver","driver":"host"}`)
	if status != 400 {
		t.Fatalf("invalid driver status=%d", status)
	}
	status, _ = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/networks",
		`{"name":"bad-cidr","subnet":"10.0.0.1"}`)
	if status != 400 {
		t.Fatalf("invalid cidr status=%d", status)
	}

	status, envelope = apiCall(t, env.handler, http.MethodDelete, "/api/v1/containers/networks/bridge", "")
	if status != 400 || envelope.Error == nil {
		t.Fatalf("predefined delete status=%d", status)
	}
	status, envelope = apiCall(t, env.handler, http.MethodDelete, "/api/v1/containers/networks/busy-net", "")
	if status != 409 || envelope.Error == nil {
		t.Fatalf("busy delete status=%d", status)
	}
	status, envelope = apiCall(t, env.handler, http.MethodDelete, "/api/v1/containers/networks/mpanel-net", "")
	if status != 200 || !envelope.OK {
		t.Fatalf("delete status=%d error=%+v", status, envelope.Error)
	}
}

func TestDaemonConfigReadWrite(t *testing.T) {
	dir := t.TempDir()
	daemonPath := filepath.Join(dir, "daemon.json")
	if err := os.WriteFile(daemonPath, []byte(`{"registry-mirrors":["https://mirror.example"],"log-driver":"json-file"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dockerDir := t.TempDir()
	auth := base64.StdEncoding.EncodeToString([]byte("alice:secret"))
	configJSON := `{"auths":{"ghcr.io":{"auth":"` + auth + `"},"registry.example":{"username":"bob"}},"credsStore":"desktop"}`
	if err := os.WriteFile(filepath.Join(dockerDir, "config.json"), []byte(configJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DOCKER_CONFIG", dockerDir)

	env := newConfigTestEnv(t, daemonPath, dockerOK)

	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/config", "")
	if status != 200 || !envelope.OK {
		t.Fatalf("get status=%d error=%+v", status, envelope.Error)
	}
	config := decodeData[ContainerDaemonConfig](t, envelope.Data)
	if len(config.RegistryMirrors) != 1 || config.RegistryMirrors[0] != "https://mirror.example" {
		t.Fatalf("mirrors: %+v", config.RegistryMirrors)
	}
	if len(config.Auths) != 2 {
		t.Fatalf("auths: %+v", config.Auths)
	}
	if config.Auths[0].Registry != "ghcr.io" || config.Auths[0].Username != "alice" {
		t.Fatalf("auth decode: %+v", config.Auths[0])
	}
	if config.CredentialStore == nil || *config.CredentialStore != "desktop" {
		t.Fatalf("credsStore: %+v", config.CredentialStore)
	}

	status, envelope = apiCall(t, env.handler, http.MethodPut, "/api/v1/containers/config",
		`{"daemonJson":"{\"registry-mirrors\":[\"https://new.example\"],\"insecure-registries\":[\"registry.local:5000\"],\"data-root\":\"/var/lib/docker\"}"}`)
	if status != 200 || !envelope.OK {
		t.Fatalf("put status=%d error=%+v", status, envelope.Error)
	}
	updated := decodeData[ContainerDaemonConfig](t, envelope.Data)
	if len(updated.RegistryMirrors) != 1 || updated.RegistryMirrors[0] != "https://new.example" {
		t.Fatalf("updated mirrors: %+v", updated.RegistryMirrors)
	}
	raw, err := os.ReadFile(daemonPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "registry.local:5000") || !strings.Contains(string(raw), "\n") {
		t.Fatalf("written file: %s", raw)
	}

	for _, body := range []string{
		`{"daemonJson":"{not json"}`,
		`{"daemonJson":"[]"}`,
		`{"daemonJson":"{\"registry-mirrors\":\"nope\"}"}`,
		`{"daemonJson":""}`,
	} {
		status, _ = apiCall(t, env.handler, http.MethodPut, "/api/v1/containers/config", body)
		if status != 400 {
			t.Fatalf("invalid body %s status=%d", body, status)
		}
	}
}

func TestDaemonConfigMissingFile(t *testing.T) {
	env := newConfigTestEnv(t, filepath.Join(t.TempDir(), "missing", "daemon.json"), dockerOK)
	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/config", "")
	if status != 200 || !envelope.OK {
		t.Fatalf("get status=%d error=%+v", status, envelope.Error)
	}
	config := decodeData[ContainerDaemonConfig](t, envelope.Data)
	if config.DaemonJSON != "{}" || len(config.RegistryMirrors) != 0 {
		t.Fatalf("missing file config: %+v", config)
	}
}

func TestValidateDaemonJSON(t *testing.T) {
	pretty, pErr := validateDaemonJSON(`{"registry-mirrors":["https://a.example"]}`)
	if pErr != nil {
		t.Fatalf("validate: %+v", pErr)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(pretty), &parsed); err != nil {
		t.Fatalf("pretty output: %v", err)
	}
	if _, ok := parsed["registry-mirrors"]; !ok {
		t.Fatalf("missing key: %s", pretty)
	}
}

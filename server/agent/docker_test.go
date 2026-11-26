package agent

import (
	"context"
	"errors"
	"testing"
	"time"
)

type stubRunner struct {
	ps      string
	code    int
	runErr  error
	calls   [][]string
	lastArg string
}

func (s *stubRunner) Run(ctx context.Context, name string, args ...string) (Result, error) {
	return s.RunTimeout(ctx, time.Second, name, args...)
}

func (s *stubRunner) RunTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) (Result, error) {
	s.calls = append(s.calls, append([]string{name}, args...))
	if s.runErr != nil {
		return Result{}, s.runErr
	}
	return Result{Stdout: s.ps, Code: s.code}, nil
}

func (s *stubRunner) Stream(ctx context.Context, name string, args []string, onLine func(string)) (Result, error) {
	return s.RunTimeout(ctx, time.Second, name, args...)
}

func TestParseComposeLabels(t *testing.T) {
	labels := ParseComposeLabels("com.docker.compose.project=mpanel-caddy,com.docker.compose.service=caddy,empty=")
	if labels[ComposeProjectLabel] != "mpanel-caddy" {
		t.Fatalf("project label: %+v", labels)
	}
	if labels[ComposeServiceLabel] != "caddy" {
		t.Fatalf("service label: %+v", labels)
	}
	if value, ok := labels["empty"]; !ok || value != "" {
		t.Fatalf("empty label: %+v", labels)
	}
}

func TestFindRunningContainer(t *testing.T) {
	runner := &stubRunner{ps: `{"ID":"abc","Names":"/mpanel-caddy","Image":"caddy:2-alpine","State":"running","Labels":"com.docker.compose.project=mpanel-caddy,com.docker.compose.service=caddy"}` + "\n" + `{"ID":"def","Names":"/other","State":"running","Labels":"com.docker.compose.project=other,com.docker.compose.service=web"}` + "\n"}
	container, err := FindRunningContainer(context.Background(), runner, "docker", "mpanel-caddy", "caddy")
	if err != nil {
		t.Fatalf("FindRunningContainer: %v", err)
	}
	if container.ID != "abc" || len(container.Names) != 1 || container.Names[0] != "mpanel-caddy" {
		t.Fatalf("container: %+v", container)
	}

	if _, err := FindRunningContainer(context.Background(), runner, "docker", "mpanel-caddy", "missing"); !errors.Is(err, ErrContainerNotFound) {
		t.Fatalf("service 不匹配应返回 ErrContainerNotFound，得到 %v", err)
	}

	empty := &stubRunner{ps: ""}
	if _, err := FindRunningContainer(context.Background(), empty, "docker", "mpanel-caddy", "caddy"); !errors.Is(err, ErrContainerNotFound) {
		t.Fatalf("空列表应返回 ErrContainerNotFound，得到 %v", err)
	}
}

func TestFindRunningContainerCommandFailure(t *testing.T) {
	runner := &stubRunner{ps: "Cannot connect to the Docker daemon", code: 1}
	if _, err := FindRunningContainer(context.Background(), runner, "docker", "mpanel-caddy", "caddy"); err == nil || errors.Is(err, ErrContainerNotFound) {
		t.Fatalf("命令失败应返回原始错误，得到 %v", err)
	}
}

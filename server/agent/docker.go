package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Compose labels used to map a running container back to a managed stack.
const (
	ComposeProjectLabel = "com.docker.compose.project"
	ComposeServiceLabel = "com.docker.compose.service"
)

// ErrContainerNotFound means docker is reachable but no container matches the
// requested compose project/service.
var ErrContainerNotFound = errors.New("container not found")

// DockerContainer is the subset of `docker ps --format json` used by managers.
type DockerContainer struct {
	ID     string
	Names  []string
	Image  string
	State  string
	Labels map[string]string
}

// dockerPSLine mirrors the JSON emitted by `docker ps --format json`.
type dockerPSLine struct {
	ID     string `json:"ID"`
	Names  string `json:"Names"`
	Image  string `json:"Image"`
	State  string `json:"State"`
	Labels string `json:"Labels"`
}

// FindRunningContainer locates a running container of a compose project and
// optional service. A missing project is ErrContainerNotFound; CLI/daemon
// failures are returned as-is so callers can distinguish capability problems.
func FindRunningContainer(ctx context.Context, runner Runner, bin, project, service string) (DockerContainer, error) {
	if runner == nil {
		return DockerContainer{}, errors.New("命令执行器未初始化")
	}
	if strings.TrimSpace(bin) == "" {
		bin = "docker"
	}
	res, err := runner.RunTimeout(ctx, 20*time.Second, bin,
		"ps",
		"--filter", "label="+ComposeProjectLabel+"="+project,
		"--filter", "status=running",
		"--format", "json",
	)
	if err != nil {
		return DockerContainer{}, err
	}
	if res.Code != 0 {
		message := strings.TrimSpace(res.Stderr)
		if message == "" {
			message = strings.TrimSpace(res.Stdout)
		}
		if message == "" {
			message = fmt.Sprintf("docker ps 退出码 %d", res.Code)
		}
		return DockerContainer{}, errors.New(message)
	}
	for _, line := range strings.Split(res.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw dockerPSLine
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		labels := ParseComposeLabels(raw.Labels)
		if labels[ComposeProjectLabel] != project {
			continue
		}
		if service != "" && labels[ComposeServiceLabel] != service {
			continue
		}
		return DockerContainer{
			ID:     strings.TrimSpace(raw.ID),
			Names:  splitDockerNames(raw.Names),
			Image:  raw.Image,
			State:  raw.State,
			Labels: labels,
		}, nil
	}
	return DockerContainer{}, ErrContainerNotFound
}

// ParseComposeLabels parses `key=value,key=value` from docker's labels column.
func ParseComposeLabels(raw string) map[string]string {
	labels := map[string]string{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		labels[key] = value
	}
	return labels
}

func splitDockerNames(raw string) []string {
	names := make([]string, 0, 1)
	for _, name := range strings.Split(raw, ",") {
		name = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "/"))
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}

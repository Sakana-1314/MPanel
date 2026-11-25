package containers

// Wire types mirror the "容器、镜像与编排" models of notes/api-contract.md §9
// and web/panel/src/api/types.ts. Optional fields are pointers so that absent
// values are rendered as null (or omitted) exactly as the contract allows.

// ContainerPort is one published or exposed container port.
type ContainerPort struct {
	IP          string `json:"ip,omitempty"`
	PrivatePort int    `json:"privatePort"`
	PublicPort  *int   `json:"publicPort,omitempty"`
	Type        string `json:"type"`
}

// ContainerSummary is one row of GET /containers.
type ContainerSummary struct {
	ID             string            `json:"id"`
	Names          []string          `json:"names"`
	Image          string            `json:"image"`
	ImageID        string            `json:"imageId,omitempty"`
	Command        string            `json:"command,omitempty"`
	Created        string            `json:"created"`
	State          string            `json:"state"`
	Status         string            `json:"status"`
	Ports          []ContainerPort   `json:"ports"`
	Labels         map[string]string `json:"labels"`
	ComposeProject *string           `json:"composeProject"`
	ComposeService *string           `json:"composeService"`
}

// ContainerMount is one entry of ContainerDetail.mounts.
type ContainerMount struct {
	Type        string `json:"type"`
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination"`
	Mode        string `json:"mode,omitempty"`
	RW          bool   `json:"rw"`
}

// ContainerDetail is the response of GET /containers/{id}.
type ContainerDetail struct {
	ContainerSummary
	Env           []string         `json:"env"`
	Mounts        []ContainerMount `json:"mounts"`
	RestartPolicy string           `json:"restartPolicy,omitempty"`
	Platform      string           `json:"platform,omitempty"`
	NetworkMode   string           `json:"networkMode,omitempty"`
	Health        *string          `json:"health,omitempty"`
}

// ContainerStats is the response of GET /containers/{id}/stats.
type ContainerStats struct {
	CPUPercent       float64 `json:"cpuPercent"`
	MemoryUsageBytes int64   `json:"memoryUsageBytes"`
	MemoryLimitBytes int64   `json:"memoryLimitBytes"`
	MemoryPercent    float64 `json:"memoryPercent"`
	NetworkRxBytes   int64   `json:"networkRxBytes"`
	NetworkTxBytes   int64   `json:"networkTxBytes"`
	BlockReadBytes   int64   `json:"blockReadBytes"`
	BlockWriteBytes  int64   `json:"blockWriteBytes"`
	PIDs             int     `json:"pids"`
	ReadAt           string  `json:"readAt"`
}

// ExecResult is the response of POST /containers/{id}/exec.
type ExecResult struct {
	ExitCode   *int   `json:"exitCode"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"durationMs"`
	Truncated  bool   `json:"truncated"`
}

// ContainerStatsResult wraps ContainerStats exactly as the contract does.
type ContainerStatsResult struct {
	Stats ContainerStats `json:"stats"`
}

// ContainerLogsResult is the response of GET /containers/{id}/logs.
type ContainerLogsResult struct {
	Logs      string `json:"logs"`
	Truncated bool   `json:"truncated"`
}

// ImageSummary is one row of GET /images.
type ImageSummary struct {
	ID          string            `json:"id"`
	RepoTags    []string          `json:"repoTags"`
	RepoDigests []string          `json:"repoDigests"`
	SizeBytes   int64             `json:"sizeBytes"`
	CreatedAt   string            `json:"createdAt"`
	Labels      map[string]string `json:"labels"`
	Dangling    bool              `json:"dangling"`
}

// ImagePullResult is the response of POST /images/pull.
type ImagePullResult struct {
	Image ImageSummary `json:"image"`
}

// ImagePruneResult is the response of POST /images/prune.
type ImagePruneResult struct {
	Deleted        int   `json:"deleted"`
	ReclaimedBytes int64 `json:"reclaimedBytes"`
}

// StackSummary is one row of GET /stacks.
type StackSummary struct {
	Name           string   `json:"name"`
	Status         string   `json:"status"`
	ConfigFiles    []string `json:"configFiles"`
	ContainerCount int      `json:"containerCount"`
	RunningCount   int      `json:"runningCount"`
	UpdatedAt      *string  `json:"updatedAt,omitempty"`
}

// StackDetail is the response of GET /stacks/{name}.
type StackDetail struct {
	StackSummary
	ComposePath string             `json:"composePath"`
	ComposeYAML string             `json:"composeYaml"`
	Containers  []ContainerSummary `json:"containers"`
}

// stackCreateInput is the body of POST /stacks.
type stackCreateInput struct {
	Name        string `json:"name"`
	ComposeYAML string `json:"composeYaml"`
}

// stackUpdateInput is the body of PUT /stacks/{name}.
type stackUpdateInput struct {
	ComposeYAML string `json:"composeYaml"`
}

// stackActionInput is the shared body of the stack action endpoints.
type stackActionInput struct {
	Build         bool `json:"build,omitempty"`
	ForceRecreate bool `json:"forceRecreate,omitempty"`
	RemoveVolumes bool `json:"removeVolumes,omitempty"`
	RemoveImages  bool `json:"removeImages,omitempty"`
}

// containerActionResult is the response of start/stop/restart.
type containerActionResult struct {
	OK     bool   `json:"ok"`
	Action string `json:"action"`
	ID     string `json:"id"`
}

// containerRemoveResult is the response of DELETE /containers/{id}.
type containerRemoveResult struct {
	Removed bool   `json:"removed"`
	ID      string `json:"id"`
}

// stackActionResult is the response of the stack up/down/restart/pull routes.
type stackActionResult struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

// stackRemoveResult is the response of DELETE /stacks/{name}.
type stackRemoveResult struct {
	Deleted bool   `json:"deleted"`
	Name    string `json:"name"`
}

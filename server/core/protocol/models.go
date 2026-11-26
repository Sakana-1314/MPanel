package protocol

// CapabilityStatus reports whether an external tool is usable on this agent.
type CapabilityStatus struct {
	Available bool           `json:"available"`
	Version   string         `json:"version,omitempty"`
	Reason    string         `json:"reason,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
}

// Capabilities is the fixed capability set of an agent.
type Capabilities struct {
	Caddy    CapabilityStatus `json:"caddy"`
	Docker   CapabilityStatus `json:"docker"`
	Postgres CapabilityStatus `json:"postgres"`
	Redis    CapabilityStatus `json:"redis"`
	PTY      CapabilityStatus `json:"pty"`
}

// WorkerDescriptor identifies an agent over a tunnel.
type WorkerDescriptor struct {
	Name            string         `json:"name"`
	Version         string         `json:"version"`
	APIVersion      int            `json:"apiVersion"`
	ProtocolVersion int            `json:"protocolVersion"`
	NodeVersion     string         `json:"nodeVersion"`
	Platform        string         `json:"platform"`
	Arch            string         `json:"arch"`
	Capabilities    map[string]any `json:"capabilities,omitempty"`
}

// SystemFeatures lists optional features the agent implements.
type SystemFeatures struct {
	DBXHandoff bool `json:"dbxHandoff"`
	WebSocket  bool `json:"websocket"`
	PTY        bool `json:"pty"`
}

// SystemPaths exposes where the agent keeps state (for operators and the UI).
type SystemPaths struct {
	Home        string   `json:"home"`
	CaddyConfig string   `json:"caddyConfig,omitempty"`
	CaddyData   string   `json:"caddyData,omitempty"`
	FilesRoots  []string `json:"filesRoots,omitempty"`
	Backups     string   `json:"backups,omitempty"`
	Stacks      string   `json:"stacks,omitempty"`
}

// SystemInfo is the response of GET /api/v1/system/info.
type SystemInfo struct {
	Role            string            `json:"role"`
	Name            string            `json:"name"`
	Version         string            `json:"version"`
	APIVersion      int               `json:"apiVersion"`
	ProtocolVersion int               `json:"protocolVersion"`
	NodeVersion     string            `json:"nodeVersion"`
	Platform        string            `json:"platform"`
	Arch            string            `json:"arch"`
	Hostname        string            `json:"hostname"`
	StartedAt       string            `json:"startedAt"`
	UptimeSec       int64             `json:"uptimeSec"`
	Capabilities    Capabilities      `json:"capabilities"`
	Worker          *WorkerDescriptor `json:"worker,omitempty"`
	Features        SystemFeatures    `json:"features"`
	Paths           *SystemPaths      `json:"paths,omitempty"`
}

// SystemSnapshot is the node snapshot taken by core for edge nodes.
type SystemSnapshot struct {
	CollectedAt    string      `json:"collectedAt"`
	Hostname       string      `json:"hostname"`
	Platform       string      `json:"platform"`
	Arch           string      `json:"arch"`
	Release        string      `json:"release"`
	NodeVersion    string      `json:"nodeVersion"`
	WorkerVersion  string      `json:"workerVersion"`
	UptimeSec      int64       `json:"uptimeSec"`
	CPUCount       int         `json:"cpuCount"`
	Loadavg        *[3]float64 `json:"loadavg"`
	MemTotalBytes  uint64      `json:"memTotalBytes"`
	MemFreeBytes   uint64      `json:"memFreeBytes"`
	DiskTotalBytes *uint64     `json:"diskTotalBytes"`
	DiskFreeBytes  *uint64     `json:"diskFreeBytes"`
	IPs            []string    `json:"ips"`
	Transport      string      `json:"transport"`
	PTY            bool        `json:"pty"`
}

// SystemMetrics is the live host metric sample.
type SystemMetrics struct {
	CollectedAt    string      `json:"collectedAt"`
	CPUPercent     *float64    `json:"cpuPercent"`
	CPUCount       int         `json:"cpuCount"`
	Loadavg        *[3]float64 `json:"loadavg"`
	MemTotalBytes  uint64      `json:"memTotalBytes"`
	MemFreeBytes   uint64      `json:"memFreeBytes"`
	DiskTotalBytes *uint64     `json:"diskTotalBytes"`
	DiskFreeBytes  *uint64     `json:"diskFreeBytes"`
	UptimeSec      int64       `json:"uptimeSec"`
}

// MachineCounts aggregates machine states for the overview.
type MachineCounts struct {
	Total    int `json:"total"`
	Online   int `json:"online"`
	Offline  int `json:"offline"`
	Starting int `json:"starting"`
	Degraded int `json:"degraded"`
	Error    int `json:"error"`
}

// SystemOverview is the core-level aggregate.
type SystemOverview struct {
	Core        SystemInfo    `json:"core"`
	Machines    MachineCounts `json:"machines"`
	Workers     []Machine     `json:"workers"`
	GeneratedAt string        `json:"generatedAt"`
}

// Machine transports and states.
const (
	TransportStdio     = "stdio"
	TransportHTTP      = "http"
	TransportReverseWS = "reverse-ws"
)

const (
	StatusOnline   = "online"
	StatusOffline  = "offline"
	StatusStarting = "starting"
	StatusDegraded = "degraded"
	StatusError    = "error"
)

// Machine is the control-plane view of one agent.
type Machine struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	Transport         string            `json:"transport"`
	Status            string            `json:"status"`
	Enabled           bool              `json:"enabled"`
	DesiredState      string            `json:"desiredState"`
	Endpoint          *string           `json:"endpoint"`
	HasToken          bool              `json:"hasToken"`
	Worker            *WorkerDescriptor `json:"worker"`
	Capabilities      *Capabilities     `json:"capabilities"`
	LastSeenAt        *string           `json:"lastSeenAt"`
	LastError         *string           `json:"lastError"`
	ReconnectAttempts int               `json:"reconnectAttempts,omitempty"`
	CreatedAt         string            `json:"createdAt"`
	UpdatedAt         string            `json:"updatedAt"`
	Edge              bool              `json:"edge"`
	Group             *string           `json:"group"`
	EdgeKeyID         *string           `json:"edgeKeyId"`
	Snapshot          *SystemSnapshot   `json:"snapshot"`
}

// MachineHealth is a health snapshot.
type MachineHealth struct {
	MachineID           string  `json:"machineId"`
	Status              string  `json:"status"`
	LastSeenAt          *string `json:"lastSeenAt"`
	LatencyMs           *int64  `json:"latencyMs,omitempty"`
	ConsecutiveFailures int     `json:"consecutiveFailures"`
	LastError           *string `json:"lastError,omitempty"`
	CheckedAt           string  `json:"checkedAt"`
}

// MachineEnrollment is the one-time reverse-ws enrollment payload.
type MachineEnrollment struct {
	MachineID string            `json:"machineId"`
	URL       string            `json:"url"`
	Secret    string            `json:"secret"`
	WorkerEnv map[string]string `json:"workerEnv"`
}

// MachineCreateResult is returned by POST /machines.
type MachineCreateResult struct {
	Machine    Machine            `json:"machine"`
	Enrollment *MachineEnrollment `json:"enrollment,omitempty"`
}

// MachineTestResult is returned by POST /machines/{id}/test.
type MachineTestResult struct {
	Reachable bool        `json:"reachable"`
	LatencyMs *int64      `json:"latencyMs,omitempty"`
	Info      *SystemInfo `json:"info,omitempty"`
	Error     string      `json:"error,omitempty"`
}

// MachineCreateInput is the decoded POST /machines body.
type MachineCreateInput struct {
	Name      string            `json:"name"`
	Enabled   *bool             `json:"enabled,omitempty"`
	Transport string            `json:"transport"`
	URL       string            `json:"url,omitempty"`
	Token     string            `json:"token,omitempty"`
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
}

// MachineUpdateInput is the decoded PATCH /machines/{id} body.
type MachineUpdateInput struct {
	Name    *string            `json:"name,omitempty"`
	Enabled *bool              `json:"enabled,omitempty"`
	URL     *string            `json:"url,omitempty"`
	Token   *string            `json:"token,omitempty"`
	Command *string            `json:"command,omitempty"`
	Args    *[]string          `json:"args,omitempty"`
	Env     *map[string]string `json:"env,omitempty"`
	Group   *string            `json:"group,omitempty"`
}

// EdgeKey authorizes self-enrollment of reverse-ws agents.
type EdgeKey struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Group      *string `json:"group"`
	ExpiresAt  *string `json:"expiresAt"`
	MaxUses    int     `json:"maxUses"`
	Uses       int     `json:"uses"`
	RevokedAt  *string `json:"revokedAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	CreatedAt  string  `json:"createdAt"`
}

// Edge key record with the hashed secret (never serialized to clients).
type EdgeKeyRecord struct {
	EdgeKey
	SecretHash string `json:"secretHash"`
}

// Edge job kinds and states.
const (
	JobSnapshot  = "snapshot"
	JobRunTask   = "run-task"
	JobApplySite = "apply-site"
)

const (
	JobPending   = "pending"
	JobRunning   = "running"
	JobSucceeded = "succeeded"
	JobFailed    = "failed"
	JobCanceled  = "canceled"
)

// EdgeJob is a queued request executed when the node is online.
type EdgeJob struct {
	ID         string         `json:"id"`
	MachineID  string         `json:"machineId"`
	Kind       string         `json:"kind"`
	Payload    map[string]any `json:"payload"`
	Status     string         `json:"status"`
	CreatedAt  string         `json:"createdAt"`
	StartedAt  *string        `json:"startedAt"`
	FinishedAt *string        `json:"finishedAt"`
	HTTPStatus *int           `json:"httpStatus"`
	Result     any            `json:"result"`
	Error      *string        `json:"error"`
}

// EdgeEnrollRequest is the body of POST /edge/enroll.
type EdgeEnrollRequest struct {
	Key      string `json:"key"`
	Name     string `json:"name,omitempty"`
	Platform string `json:"platform"`
	Arch     string `json:"arch"`
	Version  string `json:"version"`
}

// EdgeEnrollResult returns the created machine and its one-time secret.
type EdgeEnrollResult struct {
	Machine Machine `json:"machine"`
	Secret  string  `json:"secret"`
	WSURL   string  `json:"wsUrl"`
}

// EdgeKeyCreateInput is the body of POST /edge/keys.
type EdgeKeyCreateInput struct {
	Name    string  `json:"name"`
	Group   *string `json:"group,omitempty"`
	TTLSec  *int    `json:"ttlSec,omitempty"`
	MaxUses *int    `json:"maxUses,omitempty"`
}

// EdgeKeyCreateResult returns the key and its one-time secret.
type EdgeKeyCreateResult struct {
	Key    EdgeKey `json:"key"`
	Secret string  `json:"secret"`
}

// EdgeJobCreateInput is the body of POST /edge/jobs.
type EdgeJobCreateInput struct {
	MachineID string         `json:"machineId"`
	Kind      string         `json:"kind"`
	Payload   map[string]any `json:"payload,omitempty"`
}

// JobStatus is the lifecycle state of a long-running agent job.
type JobStatus string

const (
	JobStatusQueued    JobStatus = "queued"
	JobStatusRunning   JobStatus = "running"
	JobStatusSucceeded JobStatus = "succeeded"
	JobStatusFailed    JobStatus = "failed"
	JobStatusCancelled JobStatus = "cancelled"
)

// JobError is the terminal error of a failed job (mirrors PanelError).
type JobError struct {
	Code    ErrorCode      `json:"code"`
	Message string         `json:"message"`
	Hint    string         `json:"hint,omitempty"`
	Details map[string]any `json:"details,omitempty"`
}

// Job is a long-running operation exposed by GET /jobs. Result is the same
// payload the synchronous endpoint would have returned.
type Job struct {
	ID            string    `json:"id"`
	Kind          string    `json:"kind"`
	Title         string    `json:"title"`
	Status        JobStatus `json:"status"`
	Progress      int       `json:"progress"`
	Indeterminate bool      `json:"indeterminate"`
	Step          string    `json:"step,omitempty"`
	Logs          string    `json:"logs,omitempty"`
	Result        any       `json:"result,omitempty"`
	Error         *JobError `json:"error,omitempty"`
	Cancellable   bool      `json:"cancellable"`
	CreatedAt     string    `json:"createdAt"`
	StartedAt     *string   `json:"startedAt"`
	FinishedAt    *string   `json:"finishedAt"`
}

// JobStarted is returned by POST endpoints when the client asked for async
// execution with `Prefer: respond-async` or `X-MPanel-Async: 1`.
type JobStarted struct {
	Job Job `json:"job"`
}

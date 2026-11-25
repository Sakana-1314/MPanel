package protocol

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
)

// Tunnel frame kinds.
const (
	FrameHello        = "hello"
	FramePing         = "ping"
	FramePong         = "pong"
	FrameHTTPRequest  = "http-request"
	FrameHTTPResponse = "http-response"
	FrameWSOpen       = "ws-open"
	FrameWSFrame      = "ws-frame"
	FrameWSClose      = "ws-close"
)

// Frame phases for streamed HTTP bodies.
const (
	PhaseHead   = "head"
	PhaseChunk  = "chunk"
	PhaseCancel = "cancel"
)

// Frame is the single envelope multiplexed over stdio (NDJSON) and the
// reverse-ws registration socket. Fields are optional per kind.
type Frame struct {
	Kind  string `json:"kind"`
	Phase string `json:"phase,omitempty"`
	ID    string `json:"id,omitempty"`
	Seq   *int   `json:"seq,omitempty"`

	// hello
	V         int               `json:"v,omitempty"`
	Role      string            `json:"role,omitempty"`
	MachineID string            `json:"machineId,omitempty"`
	Accepted  *bool             `json:"accepted,omitempty"`
	Reason    string            `json:"reason,omitempty"`
	Token     string            `json:"token,omitempty"`
	Worker    *WorkerDescriptor `json:"worker,omitempty"`
	Core      *CoreDescriptor   `json:"core,omitempty"`
	Protocol  *ProtocolLimits   `json:"protocol,omitempty"`
	SentAt    string            `json:"sentAt,omitempty"`

	// http-request / http-response
	Method      string              `json:"method,omitempty"`
	URL         string              `json:"url,omitempty"`
	Headers     map[string][]string `json:"headers,omitempty"`
	BodyBase64  string              `json:"bodyBase64,omitempty"`
	Stream      bool                `json:"stream,omitempty"`
	Status      int                 `json:"status,omitempty"`
	ChunkBase64 string              `json:"chunkBase64,omitempty"`
	Final       bool                `json:"final,omitempty"`
	Error       *APIError           `json:"error,omitempty"`

	// ws-open / ws-frame / ws-close
	Path         string   `json:"path,omitempty"`
	Protocols    []string `json:"protocols,omitempty"`
	Data         string   `json:"data,omitempty"`
	DataEncoding string   `json:"dataEncoding,omitempty"`
	Code         int      `json:"code,omitempty"`
	Initiator    string   `json:"initiator,omitempty"`

	// ping / pong
	Ts int64 `json:"ts,omitempty"`
}

// CoreDescriptor identifies the control plane in a hello reply.
type CoreDescriptor struct {
	Name            string `json:"name"`
	Version         string `json:"version"`
	APIVersion      int    `json:"apiVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
}

// ProtocolLimits is negotiated in hello.
type ProtocolLimits struct {
	MaxFrameBytes       int `json:"maxFrameBytes"`
	ChunkBytes          int `json:"chunkBytes"`
	MaxInflightRequests int `json:"maxInflightRequests,omitempty"`
	MaxWSStreams        int `json:"maxWSStreams,omitempty"`
}

// DefaultLimits returns the protocol limits advertised in hello.
func DefaultLimits() ProtocolLimits {
	return ProtocolLimits{
		MaxFrameBytes:       MaxFrameBytes,
		ChunkBytes:          ChunkBytes,
		MaxInflightRequests: MaxInflightRequests,
		MaxWSStreams:        MaxWSStreams,
	}
}

// EncodeFrame marshals a frame.
func EncodeFrame(f *Frame) ([]byte, error) { return json.Marshal(f) }

// DecodeFrame unmarshals a frame and validates the kind.
func DecodeFrame(data []byte) (*Frame, error) {
	if len(data) > MaxFrameBytes {
		return nil, Errorf(CodeBadRequest, "隧道帧超过上限 %d 字节", MaxFrameBytes)
	}
	var f Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, &PanelError{Code: CodeBadRequest, Message: "隧道帧不是合法 JSON", Details: map[string]any{"error": err.Error()}}
	}
	switch f.Kind {
	case FrameHello, FramePing, FramePong, FrameHTTPRequest, FrameHTTPResponse, FrameWSOpen, FrameWSFrame, FrameWSClose:
		return &f, nil
	default:
		return nil, Errorf(CodeBadRequest, "未知的隧道帧类型 %q", f.Kind)
	}
}

// BoolPtr / IntPtr / StrPtr are small helpers used across packages.
func BoolPtr(v bool) *bool          { return &v }
func IntPtr(v int) *int             { return &v }
func StrPtr(v string) *string       { return &v }
func Float64Ptr(v float64) *float64 { return &v }
func Uint64Ptr(v uint64) *uint64    { return &v }

// RandomID returns a URL-safe random identifier with the given entropy bytes.
func RandomID(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

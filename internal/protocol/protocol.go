// Package protocol holds the shared wire types for the MPanel control plane
// (core) and the feature agent (agent). It is the Go side of the API contract;
// web/panel/src/api/types.ts is the browser-side mirror.
package protocol

import "fmt"

// API version and tunnel protocol version. Additive tunnel changes keep the
// protocol version; breaking changes bump it.
const (
	APIVersion           = 1
	ProtocolVersion      = 1
	TunnelSubprotocol    = "mpanel.tunnel.v1"
	MaxFrameBytes        = 16 * 1024 * 1024
	ChunkBytes           = 512 * 1024
	HeartbeatIntervalSec = 10
	HeartbeatTimeoutSec  = 30
	RequestTimeoutSec    = 120
	MaxInflightRequests  = 128
	MaxWSStreams         = 64
	MaxWSMessageBytes    = 4 * 1024 * 1024
)

// ErrorCode is the closed set of API error codes.
type ErrorCode string

const (
	CodeBadRequest    ErrorCode = "BAD_REQUEST"
	CodeUnauthorized  ErrorCode = "UNAUTHORIZED"
	CodeForbidden     ErrorCode = "FORBIDDEN"
	CodeNotFound      ErrorCode = "NOT_FOUND"
	CodeConflict      ErrorCode = "CONFLICT"
	CodeUnavailable   ErrorCode = "UNAVAILABLE"
	CodeUpstreamError ErrorCode = "UPSTREAM_ERROR"
	CodeInternal      ErrorCode = "INTERNAL"
)

// HTTPStatus maps an error code to its HTTP status.
func HTTPStatus(code ErrorCode) int {
	switch code {
	case CodeBadRequest:
		return 400
	case CodeUnauthorized:
		return 401
	case CodeForbidden:
		return 403
	case CodeNotFound:
		return 404
	case CodeConflict:
		return 409
	case CodeUnavailable:
		return 503
	case CodeUpstreamError:
		return 502
	default:
		return 500
	}
}

// APIError is the error body of an envelope.
type APIError struct {
	Code    ErrorCode      `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// PanelError is the error type carried through handlers. Handlers may return it
// directly; the HTTP layer renders it with the matching status code.
type PanelError struct {
	Code    ErrorCode
	Message string
	Details map[string]any
	Hint    string
}

func (e *PanelError) Error() string { return string(e.Code) + ": " + e.Message }

// APIError converts the error to its wire form, folding Hint into details.
func (e *PanelError) APIError() APIError {
	details := e.Details
	if e.Hint != "" {
		if details == nil {
			details = map[string]any{}
		} else {
			copied := make(map[string]any, len(details)+1)
			for k, v := range details {
				copied[k] = v
			}
			details = copied
		}
		details["hint"] = e.Hint
	}
	return APIError{Code: e.Code, Message: e.Message, Details: details}
}

// Errorf builds a PanelError with a formatted message.
func Errorf(code ErrorCode, format string, args ...any) *PanelError {
	return &PanelError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// BadRequest builds a BAD_REQUEST error.
func BadRequest(msg string) *PanelError { return &PanelError{Code: CodeBadRequest, Message: msg} }

// NotFound builds a NOT_FOUND error for a resource.
func NotFound(resource, id string) *PanelError {
	return &PanelError{Code: CodeNotFound, Message: fmt.Sprintf("%s 不存在", resource), Details: map[string]any{"resource": resource, "id": id}}
}

// Conflict builds a CONFLICT error.
func Conflict(msg string) *PanelError { return &PanelError{Code: CodeConflict, Message: msg} }

// Unavailable builds an UNAVAILABLE error with an install hint.
func Unavailable(msg, hint string) *PanelError {
	return &PanelError{Code: CodeUnavailable, Message: msg, Hint: hint}
}

// Upstream builds an UPSTREAM_ERROR.
func Upstream(msg string) *PanelError { return &PanelError{Code: CodeUpstreamError, Message: msg} }

// ListResult is the uniform list envelope: missing capabilities are reported
// with available=false and a reason instead of failing the request.
type ListResult[T any] struct {
	Available  bool   `json:"available"`
	Reason     string `json:"reason,omitempty"`
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
	Total      *int   `json:"total,omitempty"`
}

// NewList builds an available list result.
func NewList[T any](items []T) ListResult[T] {
	total := len(items)
	if items == nil {
		items = []T{}
	}
	return ListResult[T]{Available: true, Items: items, Total: &total}
}

// UnavailableList builds an unavailable list result with a reason.
func UnavailableList[T any](reason string) ListResult[T] {
	return ListResult[T]{Available: false, Reason: reason, Items: []T{}}
}

// Page applies cursor/limit to an in-memory slice. Cursor is an opaque offset
// encoded as a decimal string; limit defaults to 50 and is capped at 200.
func Page[T any](all []T, limit int, cursor string) (items []T, next string, total int) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	offset := 0
	if cursor != "" {
		for _, r := range cursor {
			if r < '0' || r > '9' {
				offset = 0
				break
			}
			offset = offset*10 + int(r-'0')
			if offset > 1_000_000 {
				offset = 1_000_000
				break
			}
		}
	}
	if offset > len(all) {
		offset = len(all)
	}
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	items = append([]T{}, all[offset:end]...)
	if end < len(all) {
		next = fmt.Sprintf("%d", end)
	}
	return items, next, len(all)
}

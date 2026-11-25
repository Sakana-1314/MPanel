// Package httpapi contains the HTTP plumbing shared by the core control plane
// and the agent: the response envelope, JSON decoding, client IP extraction,
// request ids, panic recovery and the WebSocket upgrader.
package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

// MaxJSONBytes is the JSON request body ceiling for panel APIs (contract §2.7).
const MaxJSONBytes = 1 << 20 // 1 MiB

// RequestIDHeader and APIVersionHeader are set on every envelope response.
const (
	RequestIDHeader  = "X-MPanel-Request-Id"
	APIVersionHeader = "X-MPanel-Api-Version"
	UserHeader       = "X-MPanel-User"
)

// WSUpgrader upgrades browser / agent sockets. It echoes the tunnel
// subprotocol when requested and accepts any origin: authentication is done by
// ticket / bearer token before the upgrade, never by Origin.
var WSUpgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	ReadBufferSize:   32 * 1024,
	WriteBufferSize:  32 * 1024,
	Subprotocols:     []string{protocol.TunnelSubprotocol},
	CheckOrigin:      func(*http.Request) bool { return true },
}

type envelope struct {
	OK    bool               `json:"ok"`
	Data  any                `json:"data,omitempty"`
	Error *protocol.APIError `json:"error,omitempty"`
}

func baseHeaders(w http.ResponseWriter) {
	h := w.Header()
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "application/json; charset=utf-8")
	}
	h.Set("Cache-Control", "no-store")
	h.Set(APIVersionHeader, "1")
	if h.Get(RequestIDHeader) == "" {
		h.Set(RequestIDHeader, NewRequestID())
	}
}

// OK writes {ok:true,data} with HTTP 200.
func OK(w http.ResponseWriter, data any) { writeEnvelope(w, http.StatusOK, data, nil) }

// Created writes {ok:true,data} with HTTP 201.
func Created(w http.ResponseWriter, data any) { writeEnvelope(w, http.StatusCreated, data, nil) }

// Accepted writes {ok:true,data} with HTTP 202.
func Accepted(w http.ResponseWriter, data any) { writeEnvelope(w, http.StatusAccepted, data, nil) }

func writeEnvelope(w http.ResponseWriter, status int, data any, apiErr *protocol.APIError) {
	baseHeaders(w)
	w.WriteHeader(status)
	env := envelope{OK: apiErr == nil, Data: data, Error: apiErr}
	if err := json.NewEncoder(w).Encode(env); err != nil {
		// The header is already sent; nothing useful remains except a log line.
		slog.Debug("httpapi: 写入响应失败", "error", err)
	}
}

// Fail renders err as a failure envelope. PanelError keeps its code; any other
// error becomes INTERNAL with a generic message (never a stack trace, never the
// raw error text).
func Fail(w http.ResponseWriter, err error) {
	pe := AsPanelError(err)
	apiErr := pe.APIError()
	if pe.Code == "" {
		pe.Code = protocol.CodeInternal
	}
	if apiErr.Code == protocol.CodeInternal {
		if apiErr.Details == nil {
			apiErr.Details = map[string]any{}
		}
		if _, ok := apiErr.Details["requestId"]; !ok && w.Header().Get(RequestIDHeader) != "" {
			apiErr.Details["requestId"] = w.Header().Get(RequestIDHeader)
		}
	}
	baseHeaders(w)
	w.WriteHeader(protocol.HTTPStatus(apiErr.Code))
	_ = json.NewEncoder(w).Encode(envelope{OK: false, Error: &apiErr})
}

// AsPanelError normalises an error to *protocol.PanelError. Unknown errors are
// logged (message only, no stack) and converted to INTERNAL.
func AsPanelError(err error) *protocol.PanelError {
	if err == nil {
		return &protocol.PanelError{Code: protocol.CodeInternal, Message: "内部错误"}
	}
	var pe *protocol.PanelError
	if errors.As(err, &pe) {
		if pe.Code == "" {
			pe.Code = protocol.CodeInternal
		}
		return pe
	}
	slog.Error("未处理的内部错误", "error", err.Error())
	return &protocol.PanelError{Code: protocol.CodeInternal, Message: "内部错误"}
}

// DecodeJSON decodes a JSON request body capped at MaxJSONBytes. It writes a
// failure envelope itself when decoding fails and returns false.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Body == nil {
		Fail(w, protocol.BadRequest("请求体不能为空"))
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxJSONBytes))
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return true // empty body decodes to the zero value
		}
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			Fail(w, &protocol.PanelError{
				Code:    protocol.CodeBadRequest,
				Message: "请求体超过上限",
				Hint:    "请求体最大 1 MiB；大文件请使用上传接口。",
			})
			return false
		}
		Fail(w, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "请求体不是合法 JSON",
			Details: map[string]any{"error": err.Error()},
		})
		return false
	}
	return true
}

// ClientIP returns the caller's address. X-Forwarded-For is honoured only when
// the direct peer is loopback or private, so a public client cannot spoof it.
func ClientIP(r *http.Request) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	if ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first := strings.TrimSpace(strings.Split(xff, ",")[0])
			if net.ParseIP(first) != nil {
				return first
			}
		}
		if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(real) != nil {
			return real
		}
	}
	return host
}

// NewRequestID returns a short random request id.
func NewRequestID() string {
	buf := make([]byte, 9)
	if _, err := rand.Read(buf); err != nil {
		return "req_unknown"
	}
	return "req_" + base64.RawURLEncoding.EncodeToString(buf)
}

// RequestID gives every request an id, exposes it on the response headers and
// puts it in the context so handlers can echo it.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if id == "" {
			id = NewRequestID()
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(contextWithRequestID(r.Context(), id)))
	})
}

// Recover converts handler panics into INTERNAL envelopes. The response never
// contains the panic value; the log records it with the request id.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("handler panic", "requestId", RequestIDOf(r.Context()), "path", r.URL.Path)
				Fail(w, &protocol.PanelError{Code: protocol.CodeInternal, Message: "内部错误"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type ctxKey int

const requestIDKey ctxKey = 0

func contextWithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// RequestIDOf returns the id attached by RequestID.
func RequestIDOf(ctx context.Context) string {
	v, _ := ctx.Value(requestIDKey).(string)
	return v
}

// StatusWriter records the status written by a handler (used for access logs
// and audit decisions).
type StatusWriter struct {
	http.ResponseWriter
	Status int
}

func (s *StatusWriter) WriteHeader(code int) {
	if s.Status == 0 {
		s.Status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *StatusWriter) Write(b []byte) (int, error) {
	if s.Status == 0 {
		s.Status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// WriteJSONRaw writes data as compact JSON without an envelope (used by
// /healthz and /config.json, the two contract exceptions).
func WriteJSONRaw(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

// IsWriteMethod reports whether the method mutates state (API token write
// scope requirement).
func IsWriteMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

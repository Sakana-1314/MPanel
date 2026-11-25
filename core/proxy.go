package core

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/core/httpapi"
	"github.com/sakana-1314/mpanel/core/protocol"
)

// maxProxyBody caps request bodies forwarded through the proxy (uploads).
const maxProxyBody = 64 << 20

// handleProxyHTTP forwards /api/v1/machines/{id}/proxy/* to the agent's /api/v1/*.
func (c *Core) handleProxyHTTP(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	prefix := "/api/v1/machines/" + id + "/proxy"
	suffix := strings.TrimPrefix(r.URL.Path, prefix)
	target := "/api/v1" + suffix
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	transport, err := c.machines.Transport(id)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	body, err := readLimited(r.Body, maxProxyBody)
	if err != nil {
		httpapi.Fail(w, protocol.BadRequest("请求体超过 64MiB 上限"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	resp, err := transport.Do(ctx, r.Method, target, filterHeaders(r.Header), body)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	defer resp.Body.Close()
	copyResponse(w, resp)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		c.audit.Write("proxy."+strings.ToLower(r.Method), id, "ok", map[string]any{"path": target, "status": resp.StatusCode})
	}
}

// handleProxyWS forwards /api/v1/machines/{id}/proxy/ws/* to the agent's /ws/*.
func (c *Core) handleProxyWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	prefix := "/api/v1/machines/" + id + "/proxy"
	suffix := strings.TrimPrefix(r.URL.Path, prefix)
	agentPath := "/ws" + strings.TrimPrefix(suffix, "/ws")
	if agentPath == "/ws" {
		httpapi.Fail(w, protocol.BadRequest("缺少 WebSocket 路径"))
		return
	}
	machine, err := c.machines.Get(id)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if machine.Status != protocol.StatusOnline {
		httpapi.Fail(w, protocol.Unavailable("机器不在线", "等待机器重连后再打开终端/日志"))
		return
	}
	if !c.authorizeWS(r, id, agentPath) {
		httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "WebSocket 票据无效或已过期"})
		return
	}
	transport, err := c.machines.Transport(id)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	upstream, err := transport.OpenWS(r.Context(), agentPath, filterHeaders(r.Header))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	client, err := c.upgrader.Upgrade(w, r, nil)
	if err != nil {
		_ = upstream.Close()
		return
	}
	pumpWS(client, upstream)
}

// authorizeWS accepts a one-shot ticket (bound to machine + path) or a bearer
// token. Browsers cannot set headers on WebSocket, hence the ticket flow.
func (c *Core) authorizeWS(r *http.Request, machineID, path string) bool {
	if ticket := r.URL.Query().Get("ticket"); ticket != "" {
		if c.auth.RedeemTicket(ticket, machineID, path) {
			return true
		}
	}
	if bearer(r) != "" {
		if principal, err := c.authenticate(r); err == nil && principal.Scope == "write" {
			return true
		}
	}
	return false
}

func pumpWS(client *websocket.Conn, upstream protocol.WSConn) {
	done := make(chan struct{}, 2)
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			kind, data, err := client.ReadMessage()
			if err != nil {
				_ = upstream.Close()
				return
			}
			if err := upstream.WriteMessage(kind, data); err != nil {
				return
			}
		}
	}()
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			kind, data, err := upstream.ReadMessage()
			if err != nil {
				_ = client.Close()
				return
			}
			if err := client.WriteMessage(kind, data); err != nil {
				return
			}
		}
	}()
	<-done
	_ = client.Close()
	_ = upstream.Close()
	<-done
}

// dialAgentWS opens a direct WebSocket to an agent (http transport).
func dialAgentWS(ctx context.Context, base, path, token string, header http.Header) (protocol.WSConn, error) {
	u, err := url.Parse(base)
	if err != nil {
		return nil, protocol.BadRequest("agent 地址无效")
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	}
	u.Path = path
	u.RawQuery = "token=" + url.QueryEscape(token)
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return nil, protocol.Unavailable("连接 agent WebSocket 失败", err.Error())
	}
	return conn, nil
}

func readLimited(body io.Reader, limit int64) ([]byte, error) {
	if body == nil {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("body too large")
	}
	return data, nil
}

func copyResponse(w http.ResponseWriter, resp *http.Response) {
	for key, values := range resp.Header {
		if hopByHop[strings.ToLower(key)] {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	status := resp.StatusCode
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = io.Copy(w, resp.Body)
}

var _ = json.Marshal

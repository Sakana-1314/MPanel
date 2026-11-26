package core

import (
	"net/http"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

type setupRequest struct {
	BootstrapToken string `json:"bootstrapToken"`
	Username       string `json:"username"`
	Password       string `json:"password"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (c *Core) handleSetup(w http.ResponseWriter, r *http.Request) {
	var body setupRequest
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	user, err := c.auth.Setup(body.BootstrapToken, body.Username, body.Password)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	session, err := c.auth.CreateSession()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	token, err := c.auth.IssueJWT(session)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	c.audit.Write("auth.setup", user.Username, "ok", map[string]any{"ip": c.clientIP(r)})
	httpapi.OK(w, map[string]any{"user": user, "expiresAt": session.ExpiresAt, "token": token})
}

func (c *Core) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body loginRequest
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	session, user, err := c.auth.Login(body.Username, body.Password, c.clientIP(r))
	if err != nil {
		c.audit.Write("auth.login", body.Username, "error", map[string]any{"ip": c.clientIP(r)})
		httpapi.Fail(w, err)
		return
	}
	token, err := c.auth.IssueJWT(session)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	c.audit.Write("auth.login", user.Username, "ok", map[string]any{"ip": c.clientIP(r)})
	httpapi.OK(w, map[string]any{"user": user, "expiresAt": session.ExpiresAt, "token": token})
}

// handleLogout 吊销当前会话。客户端自己丢弃 Bearer token，服务端只需删除会话记录。
func (c *Core) handleLogout(w http.ResponseWriter, r *http.Request) {
	if principal, ok := principalFrom(r); ok && principal.SessionID != "" {
		_ = c.auth.DeleteSession(principal.SessionID)
	}
	httpapi.OK(w, map[string]any{"ok": true})
}

func (c *Core) handleMe(w http.ResponseWriter, r *http.Request) {
	principal, _ := principalFrom(r)
	body := map[string]any{
		"authenticated": true,
		"role":          "core",
		"authType":      principal.AuthType,
	}
	if principal.AuthType == "session" {
		body["user"] = principal.User
	}
	httpapi.OK(w, body)
}
type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func (c *Core) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var body changePasswordRequest
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	principal, _ := principalFrom(r)
	if err := c.auth.ChangePassword(body.CurrentPassword, body.NewPassword, principal.SessionID); err != nil {
		httpapi.Fail(w, err)
		return
	}
	c.audit.Write("auth.password", principal.User.Username, "ok", nil)
	httpapi.OK(w, map[string]any{"ok": true})
}

func (c *Core) handleListTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := c.auth.ListTokens()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, protocol.NewList(tokens))
}

type createTokenRequest struct {
	Name   string `json:"name"`
	Scope  string `json:"scope"`
	TTLSec int    `json:"ttlSec"`
}

func (c *Core) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var body createTokenRequest
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	if body.Scope == "" {
		body.Scope = "write"
	}
	var ttl time.Duration
	if body.TTLSec > 0 {
		ttl = time.Duration(body.TTLSec) * time.Second
	}
	token, secret, err := c.auth.CreateToken(body.Name, body.Scope, ttl)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	c.audit.Write("auth.token.create", token.ID, "ok", map[string]any{"scope": token.Scope})
	httpapi.Created(w, map[string]any{"token": token, "secret": secret})
}

func (c *Core) handleRevokeToken(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := c.auth.RevokeToken(id); err != nil {
		httpapi.Fail(w, err)
		return
	}
	c.audit.Write("auth.token.revoke", id, "ok", nil)
	httpapi.OK(w, map[string]any{"revoked": true})
}

type wsTicketRequest struct {
	Path      string `json:"path"`
	MachineID string `json:"machineId"`
}

func (c *Core) handleWSTicket(w http.ResponseWriter, r *http.Request) {
	var body wsTicketRequest
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	path := strings.TrimSpace(body.Path)
	machineID := strings.TrimSpace(body.MachineID)
	if machineID == "" {
		httpapi.Fail(w, protocol.BadRequest("machineId 必填"))
		return
	}
	ticketPath, ok := normalizeWSTicketPath(machineID, path)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest(
			"path 必须是 /ws/... 或以 /api/v1/machines/<machineId>/proxy/ws/ 开头"))
		return
	}
	if _, err := c.machines.Get(machineID); err != nil {
		httpapi.Fail(w, err)
		return
	}
	ticket, expiresAt := c.auth.IssueTicket(machineID, ticketPath)
	httpapi.OK(w, map[string]any{"ticket": ticket, "expiresAt": expiresAt})
}

// normalizeWSTicketPath accepts both the worker-style /ws/... path and the
// contract-compliant core proxy path. The ticket is always bound to the agent
// path (/ws/...), matching handleProxyWS and auth.RedeemTicket.
func normalizeWSTicketPath(machineID, path string) (string, bool) {
	path = strings.TrimSpace(path)
	if strings.HasPrefix(path, "/ws/") {
		return path, true
	}
	prefix := "/api/v1/machines/" + machineID + "/proxy/ws"
	if path != prefix && !strings.HasPrefix(path, prefix+"/") {
		return "", false
	}
	suffix := strings.TrimPrefix(path, prefix)
	if suffix == "" {
		return "", false
	}
	return "/ws" + suffix, true
}

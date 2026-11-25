package core

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/core/auth"
	"github.com/sakana-1314/mpanel/core/protocol"
	"github.com/sakana-1314/mpanel/core/tunnel"
)

// Transport is one way to reach an agent: direct HTTP, or a multiplexed tunnel
// (stdio / reverse-ws).
type Transport interface {
	Do(ctx context.Context, method, path string, header http.Header, body []byte) (*http.Response, error)
	OpenWS(ctx context.Context, path string, header http.Header) (protocol.WSConn, error)
	Kind() string
}

// Transport resolves the transport for a machine id.
func (m *MachineManager) Transport(id string) (Transport, error) {
	rec, ok, err := m.find(id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, protocol.NotFound("machine", id)
	}
	if !rec.Enabled {
		return nil, protocol.Unavailable("机器已禁用", "在面板中启用后重试")
	}
	if rec.DesiredState != "running" {
		return nil, protocol.Unavailable("机器已断开", "在面板中重新连接后重试")
	}
	switch rec.Transport {
	case protocol.TransportHTTP:
		token, err := auth.Open(m.key, rec.TokenCipher)
		if err != nil {
			return nil, &protocol.PanelError{Code: protocol.CodeInternal, Message: "机器 token 解密失败"}
		}
		m.httpMu.Lock()
		client := m.clients[id]
		if client == nil {
			client = &http.Client{Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				MaxIdleConns:          32,
				MaxIdleConnsPerHost:   8,
				IdleConnTimeout:       90 * time.Second,
				ResponseHeaderTimeout: 60 * time.Second,
			}}
			m.clients[id] = client
		}
		m.httpMu.Unlock()
		return &httpTransport{base: strings.TrimRight(rec.URL, "/"), token: token, client: client}, nil
	case protocol.TransportReverseWS, protocol.TransportStdio:
		session := m.tunnels.Get(id)
		if session == nil {
			return nil, protocol.Unavailable("agent 未连接", "等待 agent 重连，或检查传输配置")
		}
		return &tunnelTransport{session: session}, nil
	default:
		return nil, protocol.BadRequest("未知的传输类型")
	}
}

type httpTransport struct {
	base   string
	token  string
	client *http.Client
}

func (t *httpTransport) Kind() string { return protocol.TransportHTTP }

func (t *httpTransport) Do(ctx context.Context, method, path string, header http.Header, body []byte) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, t.base+path, reader)
	if err != nil {
		return nil, protocol.BadRequest("无效的上游请求")
	}
	if header != nil {
		req.Header = cloneHeader(header)
	}
	req.Header.Set("Authorization", "Bearer "+t.token)
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return nil, protocol.Upstream("连接 agent 失败: " + err.Error())
	}
	return resp, nil
}

func (t *httpTransport) OpenWS(ctx context.Context, path string, header http.Header) (protocol.WSConn, error) {
	return dialAgentWS(ctx, t.base, path, t.token, header)
}

type tunnelTransport struct {
	session *tunnel.Session
}

func (t *tunnelTransport) Kind() string { return t.session.Kind }

func (t *tunnelTransport) Do(ctx context.Context, method, path string, header http.Header, body []byte) (*http.Response, error) {
	return t.session.Do(ctx, method, path, header, body)
}

func (t *tunnelTransport) OpenWS(ctx context.Context, path string, header http.Header) (protocol.WSConn, error) {
	return t.session.OpenWS(ctx, path, header)
}

func cloneHeader(source http.Header) http.Header {
	out := make(http.Header, len(source))
	for key, values := range source {
		copied := make([]string, len(values))
		copy(copied, values)
		out[key] = copied
	}
	return out
}

// hopByHop are headers that must not be forwarded through a proxy.
var hopByHop = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-authenticate": true,
	"proxy-authorization": true, "te": true, "trailer": true,
	"transfer-encoding": true, "upgrade": true, "host": true,
	"content-length": true,
}

func filterHeaders(header http.Header) http.Header {
	out := make(http.Header, len(header))
	for key, values := range header {
		if hopByHop[strings.ToLower(key)] {
			continue
		}
		copied := make([]string, len(values))
		copy(copied, values)
		out[key] = copied
	}
	return out
}

var errBodyTooLarge = errors.New("请求体超过 64MiB 上限")

package protocol

// WSConn is the minimal WebSocket surface shared by the tunnel, the core
// transports and the agent WS registry. *websocket.Conn satisfies it.
type WSConn interface {
	ReadMessage() (messageType int, data []byte, err error)
	WriteMessage(messageType int, data []byte) error
	Close() error
}

// WebSocket close codes used by the tunnel and the WS proxy. The first block
// is standard (RFC 6455); the 4xxx block is application defined.
const (
	WSCloseNormal          = 1000
	WSCloseGoingAway       = 1001
	WSCloseProtocolError   = 1002
	WSCloseUnsupportedData = 1003
	WSCloseTooBig          = 1009
	WSCloseInternal        = 1011
	WSCloseTryAgainLater   = 1013

	WSCloseReplaced        = 4001 // a newer connection for the same machine exists
	WSCloseVersionMismatch = 4002 // hello missing / protocol version mismatch
	WSCloseAuthFailed      = 4401
	WSCloseForbidden       = 4403
	WSCloseNotFound        = 4404
	WSCloseUpstreamDown    = 4502
)

// WebSocket message types re-exported so packages need not import gorilla only
// for the constants.
const (
	TextMessage   = 1
	BinaryMessage = 2
)

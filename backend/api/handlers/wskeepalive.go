package handlers

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"docker-manager/backend/safe"

	"github.com/gorilla/websocket"
)

// WebSocket keepalive timing. Package vars (not consts) so tests can shrink them.
// pingPeriod MUST stay strictly below pongWait so a ping → pong round-trip
// refreshes the read deadline before it expires.
var (
	wsWriteWait  = 10 * time.Second
	wsPongWait   = 60 * time.Second
	wsPingPeriod = (wsPongWait * 9) / 10 // 54s
)

// wsConn wraps a *websocket.Conn to make writes safe to call from more than one
// goroutine. gorilla/websocket forbids concurrent writers, but keepalive adds a
// pinger that writes alongside each handler's existing writer; the mutex
// serializes them.
//
// Thanks to struct embedding, every existing conn.ReadMessage / conn.Close /
// conn.SetReadDeadline call resolves to the embedded *websocket.Conn unchanged,
// while WriteMessage / WriteJSON are shadowed by the mutex-guarded versions — so
// handler bodies need no edits beyond wrapping the upgraded conn once.
//
// Do NOT write via the embedded field directly (conn.Conn.WriteMessage / .NextWriter):
// that bypasses the mutex and reintroduces the concurrent-writer race the wrapper
// exists to prevent.
type wsConn struct {
	*websocket.Conn
	mu sync.Mutex
}

func newWSConn(c *websocket.Conn) *wsConn { return &wsConn{Conn: c} }

// WriteMessage serializes with the keepalive pinger and bounds the write so a
// client whose receive buffer is full can't pin the writer goroutine forever.
func (c *wsConn) WriteMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.Conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return c.Conn.WriteMessage(messageType, data)
}

// WriteJSON marshals v and writes it as one text frame through the guarded path.
func (c *wsConn) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.WriteMessage(websocket.TextMessage, b)
}

// ping sends a control PING through the same mutex as data writes.
func (c *wsConn) ping() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteWait))
}

// startKeepalive installs a read deadline + pong handler and starts a pinger that
// runs until ctx is cancelled. The handler's existing ReadMessage loop processes
// the peer's PONG frames (gorilla handles control frames during ReadMessage),
// which refresh the read deadline. When the peer stops responding — NAT cull,
// sleeping laptop, proxy idle-timeout — no pong arrives, the deadline expires
// within ~pongWait, ReadMessage errors, the loop cancels ctx, and the connection
// is torn down (defer conn.Close), instead of lingering until the OS TCP timeout.
//
// Every handler that calls this already has an active ReadMessage loop (a reader
// goroutine, or the main control/stdin loop), which is what lets the pong handler
// fire — there is nothing to add to those loops.
func startKeepalive(ctx context.Context, c *wsConn) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(wsPongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})
	go func() {
		defer safe.Recover("ws-keepalive")
		t := time.NewTicker(wsPingPeriod)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := c.ping(); err != nil {
					return
				}
			}
		}
	}()
}

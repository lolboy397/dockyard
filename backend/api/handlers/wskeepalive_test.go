package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// shrinkKeepalive sets fast keepalive timings for a test and restores them after.
// Tests in this package run sequentially, and the role-gate tests 403 before
// upgrade, so they never observe the shrunk values.
func shrinkKeepalive(t *testing.T, write, pong, ping time.Duration) {
	t.Helper()
	ow, opo, opi := wsWriteWait, wsPongWait, wsPingPeriod
	wsWriteWait, wsPongWait, wsPingPeriod = write, pong, ping
	t.Cleanup(func() { wsWriteWait, wsPongWait, wsPingPeriod = ow, opo, opi })
}

func wsURL(s *httptest.Server) string { return "ws" + strings.TrimPrefix(s.URL, "http") }

// keepaliveServer upgrades, wraps the conn, starts keepalive, and runs the same
// reader loop the real handlers use (so the peer's pongs are processed and a dead
// peer is detected). If onTeardown is non-nil it is closed when the reader loop
// exits. extra, if non-nil, runs as a goroutine with the wrapped conn.
func keepaliveServer(t *testing.T, onTeardown chan struct{}, extra func(*wsConn, context.Context)) *httptest.Server {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn := newWSConn(raw)
		defer conn.Close()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		startKeepalive(ctx, conn)
		if extra != nil {
			go extra(conn, ctx)
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				if onTeardown != nil {
					close(onTeardown)
				}
				return
			}
		}
	}))
}

// A healthy peer that keeps ponging must receive server pings and stay connected
// well past pongWait.
func TestKeepalivePingsAndStaysAlive(t *testing.T) {
	shrinkKeepalive(t, 50*time.Millisecond, 120*time.Millisecond, 30*time.Millisecond)
	srv := keepaliveServer(t, nil, nil)
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()

	var pings int32
	c.SetPingHandler(func(appData string) error {
		atomic.AddInt32(&pings, 1)
		return c.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
	})

	readErr := make(chan error, 1)
	go func() {
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				readErr <- err
				return
			}
		}
	}()

	// pongWait is 120ms; staying open to 150ms+ proves the pongs refreshed the
	// server's read deadline rather than the link being culled.
	select {
	case err := <-readErr:
		t.Fatalf("connection closed early (%v) — keepalive should keep a ponging peer alive", err)
	case <-time.After(150 * time.Millisecond):
	}
	if n := atomic.LoadInt32(&pings); n < 1 {
		t.Fatalf("expected at least one server ping within 150ms (pingPeriod=30ms), got %d", n)
	}
}

// A peer that stops responding (never pongs) must be torn down within ~pongWait,
// not left half-open until the OS TCP timeout.
func TestKeepaliveClosesDeadPeer(t *testing.T) {
	shrinkKeepalive(t, 50*time.Millisecond, 80*time.Millisecond, 30*time.Millisecond)
	teardown := make(chan struct{})
	srv := keepaliveServer(t, teardown, nil)
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	// Deliberately never read on the client, so it never auto-pongs. The server's
	// read deadline must expire and tear the connection down.
	select {
	case <-teardown:
	case <-time.After(2 * time.Second):
		t.Fatal("server did not tear down a non-ponging peer within 2s")
	}
}

// The wrapper mutex must serialize the keepalive pinger against concurrent data
// writers. Run under -race; with pingPeriod at 1ms the pinger writes continuously
// during the data-writer burst.
func TestWSConnConcurrentWritesRace(t *testing.T) {
	shrinkKeepalive(t, 200*time.Millisecond, time.Second, time.Millisecond)
	done := make(chan struct{})
	srv := keepaliveServer(t, nil, func(conn *wsConn, _ context.Context) {
		var wg sync.WaitGroup
		for range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range 100 {
					if err := conn.WriteMessage(websocket.TextMessage, []byte("x")); err != nil {
						return
					}
				}
			}()
		}
		wg.Wait()
		close(done)
	})
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	go func() {
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent writers did not finish")
	}
}

func TestWSConnWriteJSON(t *testing.T) {
	type payload struct {
		Msg string `json:"msg"`
		N   int    `json:"n"`
	}
	srv := keepaliveServer(t, nil, func(conn *wsConn, _ context.Context) {
		_ = conn.WriteJSON(payload{Msg: "hi", N: 7})
	})
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial(wsURL(srv), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	var got payload
	if err := c.ReadJSON(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.Msg != "hi" || got.N != 7 {
		t.Fatalf("got %+v, want {hi 7}", got)
	}
}

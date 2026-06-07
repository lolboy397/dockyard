package docker

import (
	"context"
	"sync"
	"time"

	"github.com/docker/docker/client"
)

const (
	pingInterval = 500 * time.Millisecond
	idleTimeout  = 30 * time.Minute
)

// KeepAlive keeps the Docker socket connection warm while the app is in use.
// Call Touch() on every incoming HTTP request (via middleware).
// The ping goroutine starts automatically on first touch and stops after
// idleTimeout of inactivity.
type KeepAlive struct {
	cli     *client.Client
	mu      sync.Mutex
	running bool
	last    time.Time
	stop    chan struct{}
}

// NewKeepAlive creates a KeepAlive for the given Docker client and immediately
// starts warming the connection so the first user request is not cold.
func NewKeepAlive(cli *client.Client) *KeepAlive {
	ka := &KeepAlive{cli: cli}
	ka.Touch()
	return ka
}

// Touch records activity and starts the ping goroutine if not already running.
func (k *KeepAlive) Touch() {
	k.mu.Lock()
	defer k.mu.Unlock()

	k.last = time.Now()

	if k.running {
		return
	}

	k.stop = make(chan struct{})
	k.running = true
	go k.run(k.stop)
}

func (k *KeepAlive) run(stop chan struct{}) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			k.mu.Lock()
			idle := time.Since(k.last)
			if idle >= idleTimeout {
				k.running = false
				k.mu.Unlock()
				return
			}
			k.mu.Unlock()

			// Ping in the background — ignore errors (daemon may be restarting).
			// Timeout must exceed the cold-connection cost (~3s on Docker Desktop / WSL2).
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			k.cli.Ping(ctx) //nolint:errcheck
			cancel()
		}
	}
}

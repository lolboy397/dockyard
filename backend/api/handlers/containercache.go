package handlers

import (
	"context"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// containerCache is a tiny, short-TTL cache over ContainerList. Many list-page
// handlers fetch the full container list per request, and the realtime UI refetches
// on every Docker event — so M users on a busy host produce M× redundant daemon
// scans within the same instant. Caching for ~1.5s coalesces those bursts into one
// call. It is invalidated on container lifecycle events so a refetch triggered by a
// change still sees fresh data. Keyed by the `all` flag (running-only vs all).
type containerCache struct {
	ttl     time.Duration
	mu      sync.Mutex
	entries map[bool]ccEntry
	fetchMu map[bool]*sync.Mutex // serialize concurrent misses per key (no thundering herd)
}

type ccEntry struct {
	list []container.Summary
	at   time.Time
}

func newContainerCache(ttl time.Duration) *containerCache {
	return &containerCache{
		ttl:     ttl,
		entries: map[bool]ccEntry{},
		fetchMu: map[bool]*sync.Mutex{true: {}, false: {}},
	}
}

// list returns the (possibly cached) container list. Errors are never cached, so a
// transient daemon hiccup is retried on the next call.
func (c *containerCache) list(ctx context.Context, cli *client.Client, all bool) ([]container.Summary, error) {
	if l, ok := c.fresh(all); ok {
		return l, nil
	}
	// Miss: serialize fetches for this key so concurrent misses collapse into one.
	fm := c.fetchMu[all]
	fm.Lock()
	defer fm.Unlock()
	if l, ok := c.fresh(all); ok { // another goroutine may have refreshed while we waited
		return l, nil
	}
	list, err := cli.ContainerList(ctx, container.ListOptions{All: all})
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.entries[all] = ccEntry{list: list, at: time.Now()}
	c.mu.Unlock()
	return list, nil
}

func (c *containerCache) fresh(all bool) ([]container.Summary, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[all]
	if ok && time.Since(e.at) < c.ttl {
		return e.list, true
	}
	return nil, false
}

func (c *containerCache) invalidate() {
	c.mu.Lock()
	c.entries = map[bool]ccEntry{}
	c.mu.Unlock()
}

// sharedContainers backs the high-traffic list endpoints. The Docker client is a
// process-wide singleton, so a single shared cache is correct.
var sharedContainers = newContainerCache(1500 * time.Millisecond)

// InvalidateContainerCache drops the cached container lists. Call it when a
// container lifecycle event means the list has changed.
func InvalidateContainerCache() { sharedContainers.invalidate() }

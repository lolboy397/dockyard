package handlers

import (
	"context"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"
)

func TestContainerCache(t *testing.T) {
	c := newContainerCache(time.Minute)

	// Seed a fresh entry, then list() must serve it WITHOUT touching the client
	// (passing nil proves the daemon isn't called on a hit).
	c.mu.Lock()
	c.entries[true] = ccEntry{list: []container.Summary{{ID: "a"}}, at: time.Now()}
	c.mu.Unlock()

	got, err := c.list(context.Background(), nil, true)
	if err != nil || len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("cached list = %+v, err=%v; want one entry 'a' served from cache", got, err)
	}

	// Invalidate drops it.
	c.invalidate()
	if _, ok := c.fresh(true); ok {
		t.Error("entry should be gone after invalidate()")
	}

	// An expired entry is not fresh (would trigger a refetch).
	c.mu.Lock()
	c.entries[false] = ccEntry{list: []container.Summary{{ID: "old"}}, at: time.Now().Add(-time.Hour)}
	c.mu.Unlock()
	if _, ok := c.fresh(false); ok {
		t.Error("expired entry should not be considered fresh")
	}

	// Keys are independent: a fresh true-entry doesn't satisfy a false lookup.
	c.mu.Lock()
	c.entries[true] = ccEntry{list: []container.Summary{{ID: "a"}}, at: time.Now()}
	c.mu.Unlock()
	if _, ok := c.fresh(false); ok {
		t.Error("all=false must not be served by the all=true entry")
	}
}

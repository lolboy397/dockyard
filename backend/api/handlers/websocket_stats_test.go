package handlers

import (
	"context"
	"testing"
	"time"
)

// The shared stats hub must fan one collection out to every subscriber and run the
// collection loop only while at least one subscriber is connected.
func TestStatsHubFanOutAndLifecycle(t *testing.T) {
	snap := []ContainerStatSummary{{ID: "a", CPU: 1.5}}
	hub := newStatsHub(nil)
	hub.collectFn = func(context.Context) []ContainerStatSummary { return snap }

	ch1, unsub1 := hub.subscribe()
	ch2, unsub2 := hub.subscribe()

	// One shared collection reaches BOTH subscribers.
	for i, ch := range []<-chan []ContainerStatSummary{ch1, ch2} {
		select {
		case got := <-ch:
			if len(got) != 1 || got[0].ID != "a" {
				t.Errorf("subscriber %d got %+v, want one entry for 'a'", i, got)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("subscriber %d timed out waiting for a snapshot", i)
		}
	}

	if !hub.running() {
		t.Error("loop should be running while subscribers exist")
	}

	unsub1()
	if !hub.running() {
		t.Error("loop should keep running while one subscriber remains")
	}

	unsub2()
	if hub.running() {
		t.Error("loop should stop once the last subscriber leaves")
	}

	// Unsubscribing again must be a safe no-op (no double-close / double-cancel).
	unsub2()
}

func (s *statsHub) running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancel != nil
}

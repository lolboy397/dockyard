package docker

import (
	"reflect"
	"sort"
	"testing"

	"github.com/docker/docker/api/types/network"
)

func TestBuildRecreateEndpoints(t *testing.T) {
	oldID := "abc123def4567890aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // shortID = abc123def456

	t.Run("preserves the service alias and drops the stale short-id alias", func(t *testing.T) {
		nets := map[string]*network.EndpointSettings{
			"appnet": {Aliases: []string{"abc123def456", "api"}, IPAddress: "172.18.0.5"},
		}
		got := buildRecreateEndpoints(nets, oldID, "api")
		if len(got) != 1 {
			t.Fatalf("got %d networks, want 1", len(got))
		}
		ep := got["appnet"]
		if ep == nil {
			t.Fatal("appnet endpoint missing")
		}
		if !reflect.DeepEqual(ep.Aliases, []string{"api"}) {
			t.Errorf("aliases = %v, want [api] (short-id dropped, service kept)", ep.Aliases)
		}
		// The old static IP must NOT be carried over — Docker assigns a fresh one.
		if ep.IPAddress != "" {
			t.Errorf("IPAddress = %q, want empty (let Docker assign)", ep.IPAddress)
		}
	})

	t.Run("adds the service alias when it was missing", func(t *testing.T) {
		nets := map[string]*network.EndpointSettings{
			"appnet": {Aliases: []string{"abc123def456"}},
		}
		got := buildRecreateEndpoints(nets, oldID, "web")
		if !reflect.DeepEqual(got["appnet"].Aliases, []string{"web"}) {
			t.Errorf("aliases = %v, want [web]", got["appnet"].Aliases)
		}
	})

	t.Run("multiple networks are all preserved", func(t *testing.T) {
		nets := map[string]*network.EndpointSettings{
			"front": {Aliases: []string{"api"}},
			"back":  {Aliases: []string{"api"}},
		}
		got := buildRecreateEndpoints(nets, oldID, "api")
		if len(got) != 2 || got["front"] == nil || got["back"] == nil {
			t.Errorf("expected both networks preserved, got %v", got)
		}
	})

	t.Run("no service label still keeps real aliases", func(t *testing.T) {
		nets := map[string]*network.EndpointSettings{
			"appnet": {Aliases: []string{"abc123def456", "custom-alias"}},
		}
		got := buildRecreateEndpoints(nets, oldID, "")
		if !reflect.DeepEqual(got["appnet"].Aliases, []string{"custom-alias"}) {
			t.Errorf("aliases = %v, want [custom-alias]", got["appnet"].Aliases)
		}
	})
}

func TestSplitPrimaryNetwork(t *testing.T) {
	t.Run("empty endpoints", func(t *testing.T) {
		cfg, extra := splitPrimaryNetwork("bridge", nil)
		if cfg != nil || extra != nil {
			t.Errorf("want (nil,nil) for no endpoints, got (%v,%v)", cfg, extra)
		}
	})

	t.Run("primary hint is used and the rest are extras", func(t *testing.T) {
		endpoints := map[string]*network.EndpointSettings{
			"appnet":  {Aliases: []string{"api"}},
			"metrics": {Aliases: []string{"api"}},
		}
		cfg, extra := splitPrimaryNetwork("appnet", endpoints)
		if cfg == nil || len(cfg.EndpointsConfig) != 1 {
			t.Fatalf("primary config = %v, want exactly appnet", cfg)
		}
		if _, ok := cfg.EndpointsConfig["appnet"]; !ok {
			t.Errorf("primary should be the hinted network appnet, got %v", keys(cfg.EndpointsConfig))
		}
		if len(extra) != 1 {
			t.Fatalf("extra = %v, want 1 (metrics)", extra)
		}
		if _, ok := extra["metrics"]; !ok {
			t.Errorf("extra should be metrics, got %v", keys(extra))
		}
	})

	t.Run("unknown hint falls back to an available network", func(t *testing.T) {
		endpoints := map[string]*network.EndpointSettings{"only": {Aliases: []string{"x"}}}
		cfg, extra := splitPrimaryNetwork("does-not-exist", endpoints)
		if cfg == nil || cfg.EndpointsConfig["only"] == nil {
			t.Errorf("want fallback to the single network, got %v", cfg)
		}
		if len(extra) != 0 {
			t.Errorf("want no extras, got %v", extra)
		}
	})
}

func keys(m map[string]*network.EndpointSettings) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

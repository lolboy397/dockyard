package handlers

import "testing"

func TestRefRepo(t *testing.T) {
	cases := []struct{ in, want string }{
		{"ghcr.io/lolboy397/dockyard-backend:latest", "ghcr.io/lolboy397/dockyard-backend"},
		{"ghcr.io/lolboy397/dockyard-backend:0.0.1", "ghcr.io/lolboy397/dockyard-backend"},
		{"ghcr.io/lolboy397/dockyard-backend", "ghcr.io/lolboy397/dockyard-backend"},
		{"ghcr.io/o/dockyard-backend@sha256:abc", "ghcr.io/o/dockyard-backend"},
		{"ghcr.io/o/dockyard-backend:latest@sha256:abc", "ghcr.io/o/dockyard-backend"},
		{"nginx", "nginx"},
		{"nginx:1.27", "nginx"},
		// registry with explicit port must not be mistaken for a tag.
		{"localhost:5000/app:dev", "localhost:5000/app"},
		{"localhost:5000/app", "localhost:5000/app"},
	}
	for _, c := range cases {
		if got := refRepo(c.in); got != c.want {
			t.Errorf("refRepo(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRefTag(t *testing.T) {
	cases := []struct{ in, want string }{
		{"ghcr.io/o/dockyard-backend:latest", "latest"},
		{"ghcr.io/o/dockyard-backend:0.0.1", "0.0.1"},
		{"ghcr.io/o/dockyard-backend", "latest"},
		{"localhost:5000/app:dev", "dev"},
		{"localhost:5000/app", "latest"},
		{"ghcr.io/o/dockyard-backend:latest@sha256:abc", "latest"},
	}
	for _, c := range cases {
		if got := refTag(c.in); got != c.want {
			t.Errorf("refTag(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsDockyardImage(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"ghcr.io/lolboy397/dockyard-backend:latest", true},
		{"ghcr.io/lolboy397/dockyard-frontend:latest", true},
		{"tecnativa/docker-socket-proxy:0.3.0", false},
		{"registry:2", false},
		{"nginx:latest", false},
	}
	for _, c := range cases {
		if got := isDockyardImage(c.in); got != c.want {
			t.Errorf("isDockyardImage(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

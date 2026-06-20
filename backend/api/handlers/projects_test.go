package handlers

import (
	"reflect"
	"slices"
	"testing"

	"docker-manager/backend/storage"

	"github.com/docker/docker/api/types/container"
)

func TestCleanupCancelTokenGuard(t *testing.T) {
	h := &ProjectHandlers{cancels: make(map[int64]buildCtl)}
	calls := 0
	h.cancels[7] = buildCtl{cancel: func() { calls++ }, token: 1}

	// A stale cleanup (wrong token — e.g. an older, stopped build whose goroutine
	// is only now winding down) must NOT remove or cancel the current entry.
	h.cleanupCancel(7, 99)
	if _, ok := h.cancels[7]; !ok {
		t.Fatal("entry removed by a non-owning token")
	}
	if calls != 0 {
		t.Fatalf("cancel invoked by wrong token (%d times)", calls)
	}

	// The owning token tears down and cancels exactly once.
	h.cleanupCancel(7, 1)
	if _, ok := h.cancels[7]; ok {
		t.Fatal("entry not removed by its owning token")
	}
	if calls != 1 {
		t.Fatalf("cancel invoked %d times, want 1", calls)
	}
}

func TestBuildCommandArgs(t *testing.T) {
	df := &storage.Project{Type: "dockerfile", Name: "app", ImageTag: "project-app:latest", Path: "/data/projects/app"}
	cmp := &storage.Project{Type: "compose", Name: "app", Path: "/data/projects/app"}

	// Cached (default) builds must NOT pass --no-cache.
	if got := buildCommandArgs(df, false); slices.Contains(got, "--no-cache") {
		t.Errorf("dockerfile cached build should not include --no-cache: %v", got)
	}
	if got := buildCommandArgs(cmp, false); slices.Contains(got, "--no-cache") {
		t.Errorf("compose cached build should not include --no-cache: %v", got)
	}

	// Forced builds must pass --no-cache.
	dfNo := buildCommandArgs(df, true)
	if !slices.Contains(dfNo, "--no-cache") || !slices.Contains(dfNo, "project-app:latest") {
		t.Errorf("dockerfile no-cache build wrong: %v", dfNo)
	}
	cmpNo := buildCommandArgs(cmp, true)
	if cmpNo[0] != "compose" || !slices.Contains(cmpNo, "build") || !slices.Contains(cmpNo, "--no-cache") {
		t.Errorf("compose no-cache build wrong: %v", cmpNo)
	}
}

func TestParseHostPort(t *testing.T) {
	cases := []struct {
		in   string
		want declaredPort
		ok   bool
	}{
		{"8080:80", declaredPort{Host: 8080, Container: "80"}, true},
		{"0.0.0.0:8080:80", declaredPort{Host: 8080, Container: "80"}, true},
		{"127.0.0.1:5432:5432", declaredPort{Host: 5432, Container: "5432"}, true},
		{"8080:80/tcp", declaredPort{Host: 8080, Container: "80"}, true},
		{`"8080:80"`, declaredPort{Host: 8080, Container: "80"}, true},
		{"  8080:80  ", declaredPort{Host: 8080, Container: "80"}, true},
		{"80", declaredPort{}, false},   // bare port → random host port, can't conflict
		{"", declaredPort{}, false},     // empty
		{"abc:def", declaredPort{}, false},
	}
	for _, c := range cases {
		got, ok := parseHostPort(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseHostPort(%q) = (%+v, %v), want (%+v, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestHostPortDeclared(t *testing.T) {
	ports := "8080:80, 0.0.0.0:9090:90, 3000"
	if !hostPortDeclared(ports, "8080") {
		t.Error("8080 should be declared")
	}
	if !hostPortDeclared(ports, "9090") {
		t.Error("9090 should be declared (IP-prefixed)")
	}
	if hostPortDeclared(ports, "80") {
		t.Error("80 is a container port, not a host port — should not match")
	}
	if hostPortDeclared(ports, "3000") {
		t.Error("3000 is a bare port (random host), should not match")
	}
}

func TestComposeDeclaredPorts(t *testing.T) {
	content := `services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
      - "127.0.0.1:8443:443"
    environment:
      FOO: 1
  db:
    image: postgres:16
    ports:
      - 5432:5432`
	got := composeDeclaredPorts(content)
	want := []declaredPort{
		{Host: 8080, Container: "80"},
		{Host: 8443, Container: "443"},
		{Host: 5432, Container: "5432"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("composeDeclaredPorts() = %+v, want %+v", got, want)
	}
}

func TestComposeDeclaredPortsIgnoresNonPortBlocks(t *testing.T) {
	// "n:n"-looking tokens outside a ports: block (image tags, env values) must
	// not be mistaken for port mappings.
	content := `services:
  app:
    image: myregistry:5000/app:1.2
    environment:
      RANGE: "10:20"`
	if got := composeDeclaredPorts(content); len(got) != 0 {
		t.Errorf("composeDeclaredPorts() = %+v, want empty", got)
	}
}

func TestSuggestFreePort(t *testing.T) {
	used := map[int]portHolder{8081: {}, 8082: {}}
	declared := map[int]bool{8080: true, 8083: true}
	// 8081/8082 are taken, 8083 is declared by the project → first free is 8084.
	if got := suggestFreePort(8080, used, declared); got != 8084 {
		t.Errorf("suggestFreePort = %d, want 8084", got)
	}
	if got := suggestFreePort(65535, used, declared); got != 0 {
		t.Errorf("suggestFreePort(65535) = %d, want 0 (no room)", got)
	}
}

func TestComputePortConflicts(t *testing.T) {
	declared := []declaredPort{{Host: 8080, Container: "80"}, {Host: 9000, Container: "90"}}

	t.Run("conflict with another container", func(t *testing.T) {
		used := map[int]portHolder{8080: {name: "otherapp"}}
		results, has := computePortConflicts(declared, used, "project-mine", "proj-mine")
		if !has {
			t.Fatal("expected a conflict")
		}
		if !results[0].InUse || results[0].UsedBy != "otherapp" || results[0].Suggested == 0 {
			t.Errorf("port 8080: %+v, want in_use by otherapp with a suggestion", results[0])
		}
		if results[1].InUse {
			t.Errorf("port 9000 should be free, got %+v", results[1])
		}
	})

	t.Run("own dockerfile container is not a conflict", func(t *testing.T) {
		used := map[int]portHolder{8080: {name: "project-mine"}}
		_, has := computePortConflicts(declared, used, "project-mine", "proj-mine")
		if has {
			t.Error("a project's own container should not count as a conflict")
		}
	})

	t.Run("own compose container is not a conflict", func(t *testing.T) {
		used := map[int]portHolder{8080: {name: "proj-mine-web-1", composeProject: "proj-mine"}}
		_, has := computePortConflicts(declared, used, "project-mine", "proj-mine")
		if has {
			t.Error("a project's own compose container should not count as a conflict")
		}
	})

	t.Run("no running containers, no conflict", func(t *testing.T) {
		results, has := computePortConflicts(declared, map[int]portHolder{}, "project-mine", "proj-mine")
		if has {
			t.Error("expected no conflict")
		}
		if len(results) != 2 {
			t.Errorf("expected 2 port results, got %d", len(results))
		}
	})
}

func TestReplaceDeclaredHostPort(t *testing.T) {
	cases := []struct {
		ports, oldP, newP, want string
	}{
		{"8080:80", "8080", "9090", "9090:80"},
		{"8080:80, 5432:5432", "5432", "5433", "8080:80, 5433:5432"},
		// Must remap only the host side, never a digit-substring of another mapping:
		// remapping "80" must NOT corrupt "8080:80".
		{"8080:80", "80", "9090", "8080:80"},
		// Unknown port leaves the string untouched.
		{"8080:80", "1234", "9090", "8080:80"},
	}
	for _, c := range cases {
		if got := replaceDeclaredHostPort(c.ports, c.oldP, c.newP); got != c.want {
			t.Errorf("replaceDeclaredHostPort(%q, %q, %q) = %q, want %q", c.ports, c.oldP, c.newP, got, c.want)
		}
	}
}

func TestPublishedMappings(t *testing.T) {
	ports := []container.Port{
		{PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0"},
		{PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "::"}, // IPv6 dup → collapses
		{PrivatePort: 5432, PublicPort: 5432, Type: "tcp"},
		{PrivatePort: 9000, PublicPort: 0, Type: "tcp"}, // not published → dropped
	}
	got := publishedMappings(ports)
	want := []storage.PortMapping{
		{Host: "5432", Container: "5432", Protocol: "tcp"},
		{Host: "8080", Container: "80", Protocol: "tcp"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("publishedMappings() = %+v, want %+v", got, want)
	}
}

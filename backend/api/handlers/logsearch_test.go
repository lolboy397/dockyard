package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/docker/docker/pkg/stdcopy"
)

// muxLog encodes lines as a Docker (non-TTY) multiplexed stdout stream, the shape
// ContainerLogs returns and searchLogStream demuxes.
func muxLog(lines ...string) *bytes.Buffer {
	var buf bytes.Buffer
	w := stdcopy.NewStdWriter(&buf, stdcopy.Stdout)
	for _, l := range lines {
		_, _ = w.Write([]byte(l + "\n"))
	}
	return &buf
}

func substr(needle string) func(string) bool {
	m, _ := compileLogMatcher(needle, false)
	return m
}

func TestSearchLogStreamSubstring(t *testing.T) {
	src := muxLog(
		"2026-06-27T10:00:00Z starting up",
		"2026-06-27T10:00:01Z ERROR connection refused",
		"2026-06-27T10:00:02Z GET /health 200",
		"2026-06-27T10:00:03Z error: retry failed",
	)
	res := searchLogStream(context.Background(), src, substr("error"), 100)
	if res.Scanned != 4 {
		t.Errorf("scanned = %d, want 4", res.Scanned)
	}
	if len(res.Matches) != 2 {
		t.Fatalf("matches = %d, want 2 (case-insensitive)", len(res.Matches))
	}
	if res.Truncated {
		t.Errorf("truncated = true, want false (all lines fit)")
	}
	if res.Matches[0].TS != "2026-06-27T10:00:01Z" || res.Matches[0].Level != "err" {
		t.Errorf("first match = %+v, want ts=…:01Z level=err", res.Matches[0])
	}
	if res.Matches[0].Text != "ERROR connection refused" {
		t.Errorf("match text = %q (timestamp should be stripped)", res.Matches[0].Text)
	}
}

func TestSearchLogStreamRegex(t *testing.T) {
	src := muxLog(
		"2026-06-27T10:00:00Z user=alice action=login",
		"2026-06-27T10:00:01Z user=bob action=logout",
		"2026-06-27T10:00:02Z healthcheck ok",
	)
	re := regexp.MustCompile(`action=log(in|out)`)
	res := searchLogStream(context.Background(), src, re.MatchString, 100)
	if len(res.Matches) != 2 {
		t.Fatalf("regex matches = %d, want 2", len(res.Matches))
	}
}

func TestSearchLogStreamLimitTruncates(t *testing.T) {
	src := muxLog(
		"2026-06-27T10:00:00Z hit one",
		"2026-06-27T10:00:01Z hit two",
		"2026-06-27T10:00:02Z hit three",
	)
	res := searchLogStream(context.Background(), src, substr("hit"), 2)
	if len(res.Matches) != 2 {
		t.Fatalf("matches = %d, want 2 (capped)", len(res.Matches))
	}
	if !res.Truncated {
		t.Errorf("truncated = false, want true (limit hit with more behind)")
	}
}

// SearchLogs must refuse read-only/anonymous callers (logs can carry secrets) and
// let operator/admin past the gate (they then 400 on the missing q, never 403).
func TestSearchLogsRoleGate(t *testing.T) {
	h := &ContainerHandlers{} // docker is never reached: gate + q-check run first
	cases := []struct {
		role          string
		wantForbidden bool
	}{
		{"", true},
		{"viewer", true},
		{"operator", false},
		{"admin", false},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.SearchLogs(rec, reqWithRole(c.role))
		gotForbidden := rec.Code == http.StatusForbidden
		if gotForbidden != c.wantForbidden {
			t.Errorf("role %q: status=%d, wantForbidden=%v", c.role, rec.Code, c.wantForbidden)
		}
	}
}

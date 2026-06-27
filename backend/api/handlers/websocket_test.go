package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"docker-manager/backend/storage"
)

// reqWithRole builds a GET /ws/exec request carrying an authenticated user of
// the given role in context (as RequireAuth would). An empty role means no
// authenticated user is attached.
func reqWithRole(role string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/ws/exec?id=abc123", nil)
	if role != "" {
		u := &storage.User{Role: role, Active: true}
		r = r.WithContext(context.WithValue(r.Context(), userCtxKey, u))
	}
	return r
}

// TestStreamExecRoleGate verifies that the interactive container shell is
// refused for read-only/anonymous callers and permitted (past the role gate)
// for operator/admin. Operator/admin requests are not real WebSocket upgrades
// here, so they fail at the upgrade step with 400 — the point is they are NOT
// rejected with 403, proving the role gate let them through.
func TestStreamExecRoleGate(t *testing.T) {
	h := &WSHandlers{} // docker client is never reached on these paths
	cases := []struct {
		role          string
		wantForbidden bool
	}{
		{"", true},          // unauthenticated
		{"viewer", true},    // read-only must be blocked
		{"operator", false}, // allowed past the gate
		{"admin", false},    // allowed past the gate
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.StreamExec(rec, reqWithRole(c.role))
		gotForbidden := rec.Code == http.StatusForbidden
		if gotForbidden != c.wantForbidden {
			t.Errorf("role %q: status=%d, wantForbidden=%v", c.role, rec.Code, c.wantForbidden)
		}
	}
}

// TestLogStreamRoleGate verifies that the log-content WebSocket endpoints are
// refused for read-only/anonymous callers and permitted (past the role gate) for
// operator/admin — logs can leak secrets, so they sit above the base viewer
// read capability. As with exec, operator/admin requests aren't real WebSocket
// upgrades here, so they fail later with 400; the point is they are NOT 403.
func TestLogStreamRoleGate(t *testing.T) {
	h := &WSHandlers{} // docker client is never reached: the gate runs before any docker call
	handlers := map[string]http.HandlerFunc{
		"StreamLogs":      h.StreamLogs,
		"StreamMultiLogs": h.StreamMultiLogs,
	}
	cases := []struct {
		role          string
		wantForbidden bool
	}{
		{"", true},          // unauthenticated
		{"viewer", true},    // read-only must be blocked from log content
		{"operator", false}, // allowed past the gate
		{"admin", false},    // allowed past the gate
	}
	for name, fn := range handlers {
		for _, c := range cases {
			rec := httptest.NewRecorder()
			fn(rec, reqWithRole(c.role))
			gotForbidden := rec.Code == http.StatusForbidden
			if gotForbidden != c.wantForbidden {
				t.Errorf("%s role %q: status=%d, wantForbidden=%v", name, c.role, rec.Code, c.wantForbidden)
			}
		}
	}
}

func TestLineLevel(t *testing.T) {
	cases := []struct{ msg, want string }{
		{"plain info line", "info"},
		{"GET /health 200 OK", "info"},
		{"disk usage WARNING high", "warn"},
		{"WARN: retrying", "warn"},
		{"ERROR: connection refused", "err"},
		{"panic: runtime error", "err"},
		{"FATAL shutdown", "err"},
		{"WARNING then ERROR — warn wins", "warn"}, // warn checked before err
		{"scattered (error) word", "err"},          // case-insensitive
	}
	for _, c := range cases {
		if got := lineLevel(c.msg); got != c.want {
			t.Errorf("lineLevel(%q) = %q, want %q", c.msg, got, c.want)
		}
	}
}

func TestMatchLevel(t *testing.T) {
	if !matchLevel("", "info") || !matchLevel("all", "err") {
		t.Error("empty/all filter must pass any level")
	}
	if !matchLevel("err", "err") || matchLevel("err", "info") {
		t.Error("a specific filter must pass only its own level")
	}
}

func TestSplitLogTimestamp(t *testing.T) {
	cases := []struct {
		name    string
		line    string
		wantTS  string
		wantMsg string
	}{
		{
			name:    "rfc3339nano prefix is split off",
			line:    "2026-06-27T10:00:00.123456789Z hello world",
			wantTS:  "2026-06-27T10:00:00.123456789Z",
			wantMsg: "hello world",
		},
		{
			name:    "second-precision offset timestamp",
			line:    "2026-06-27T10:00:00+01:00 started",
			wantTS:  "2026-06-27T10:00:00+01:00",
			wantMsg: "started",
		},
		{
			name:    "message keeps its own internal spacing",
			line:    "2026-06-27T10:00:00Z  GET /  200",
			wantTS:  "2026-06-27T10:00:00Z",
			wantMsg: " GET /  200",
		},
		{
			name:    "no timestamp prefix passes through unchanged",
			line:    "plain log line with no timestamp",
			wantTS:  "",
			wantMsg: "plain log line with no timestamp",
		},
		{
			name:    "non-timestamp first token is not mistaken for one",
			line:    "INFO something happened",
			wantTS:  "",
			wantMsg: "INFO something happened",
		},
		{
			name:    "empty line",
			line:    "",
			wantTS:  "",
			wantMsg: "",
		},
		{
			name:    "leading space (no leading token) passes through",
			line:    " indented continuation line",
			wantTS:  "",
			wantMsg: " indented continuation line",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts, msg := splitLogTimestamp(tc.line)
			if ts != tc.wantTS {
				t.Errorf("ts = %q, want %q", ts, tc.wantTS)
			}
			if msg != tc.wantMsg {
				t.Errorf("msg = %q, want %q", msg, tc.wantMsg)
			}
		})
	}
}

func TestCanWriteAndIsAdmin(t *testing.T) {
	cases := []struct {
		role        string
		canWrite    bool
		isAdmin     bool
		canViewLogs bool
	}{
		{"admin", true, true, true},
		{"operator", true, false, true},
		{"viewer", false, false, false},
		{"", false, false, false},
	}
	for _, c := range cases {
		r := reqWithRole(c.role)
		if got := canWrite(r); got != c.canWrite {
			t.Errorf("canWrite(%q)=%v, want %v", c.role, got, c.canWrite)
		}
		if got := isAdmin(r); got != c.isAdmin {
			t.Errorf("isAdmin(%q)=%v, want %v", c.role, got, c.isAdmin)
		}
		if got := canViewLogs(r); got != c.canViewLogs {
			t.Errorf("canViewLogs(%q)=%v, want %v", c.role, got, c.canViewLogs)
		}
	}
}

package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// TestWriteErrorSanitizes5xx is the regression guard for the info-disclosure fix:
// internal (5xx) errors must never reach the client, while caller-facing (4xx)
// messages pass through unchanged.
func TestWriteErrorSanitizes5xx(t *testing.T) {
	decode := func(rec *httptest.ResponseRecorder) string {
		var body errorResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return body.Error
	}

	// 5xx must be redacted to a generic message — no internal detail leaks.
	rec := httptest.NewRecorder()
	writeError(rec, 500, errMsg("pq: password authentication failed for user 'admin'"))
	if rec.Code != 500 {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if got := decode(rec); got != "internal server error" {
		t.Errorf("5xx body = %q — must be generic, the raw error leaked", got)
	}

	// 4xx messages are caller-facing and returned verbatim.
	rec = httptest.NewRecorder()
	writeError(rec, 400, errMsg("username must be at least 3 characters"))
	if got := decode(rec); got != "username must be at least 3 characters" {
		t.Errorf("4xx body = %q — should pass through", got)
	}

	// 404 also passes through.
	rec = httptest.NewRecorder()
	writeError(rec, 404, errMsg("not found"))
	if got := decode(rec); got != "not found" {
		t.Errorf("404 body = %q — should pass through", got)
	}
}

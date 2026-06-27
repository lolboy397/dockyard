package handlers

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestDiagWriterErrorForwarding verifies the correlation plumbing: a writeError
// 5xx made through AuditMutations' statusWriter (which wraps the capture
// middleware's diagWriter) must record the REAL error on the diagWriter, set the
// status, and still send the client a sanitized body.
func TestDiagWriterErrorForwarding(t *testing.T) {
	rec := httptest.NewRecorder()
	dw := &diagWriter{ResponseWriter: rec}
	sw := &statusWriter{ResponseWriter: dw, status: 200}

	writeError(sw, 500, errMsg("inner db boom"))

	if dw.err == nil || dw.err.Error() != "inner db boom" {
		t.Errorf("diagWriter.err = %v, want 'inner db boom' (recordError forwarding broken)", dw.err)
	}
	if dw.status != 500 {
		t.Errorf("diagWriter.status = %d, want 500", dw.status)
	}
	if body := rec.Body.String(); !strings.Contains(body, "internal server error") || strings.Contains(body, "inner db boom") {
		t.Errorf("5xx body leaked through the writer chain: %s", body)
	}
}

// TestDiagFingerprint verifies grouping: occurrences that differ only by ids /
// numbers collapse to one fingerprint, while a different route or source does not.
func TestDiagFingerprint(t *testing.T) {
	a := diagFingerprint("backend", "/api/v1/containers/{id}", 500, "container abc123def456 not found: id 42")
	b := diagFingerprint("backend", "/api/v1/containers/{id}", 500, "container 0099aabbccdd not found: id 7")
	if a != b {
		t.Errorf("similar messages should share a fingerprint: %q vs %q", a, b)
	}

	if c := diagFingerprint("backend", "/api/v1/images/{id}", 500, "container abc123def456 not found: id 42"); a == c {
		t.Error("different routes must not group together")
	}
	if d := diagFingerprint("frontend", "/api/v1/containers/{id}", 500, "container abc123def456 not found: id 42"); a == d {
		t.Error("different sources must not group together")
	}
	if len(a) != 16 {
		t.Errorf("fingerprint length = %d, want 16", len(a))
	}

	// First line only — a differing stack tail must not split the group.
	e := diagFingerprint("backend", "/x", 500, "boom\nat foo()\nat bar()")
	f := diagFingerprint("backend", "/x", 500, "boom\nat baz()")
	if e != f {
		t.Error("fingerprint should key on the first message line only")
	}
}

func TestClipAndAtoi(t *testing.T) {
	if clip("hello", 3) != "hel" {
		t.Error("clip should truncate")
	}
	if clip("hi", 10) != "hi" {
		t.Error("clip should leave short strings")
	}
	if atoiDefault("25", 100) != 25 || atoiDefault("", 100) != 100 || atoiDefault("-5", 100) != 100 {
		t.Error("atoiDefault parsing/fallback wrong")
	}
}

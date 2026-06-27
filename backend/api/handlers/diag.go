package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// DiagHandlers powers "Dockyard Insights": it auto-captures backend 5xx/panics,
// ingests frontend errors, and serves the admin issue feed. Writes go through an
// async, storm-safe sink so a render loop (or a flapping backend) can never block
// the request path or hammer SQLite.
type DiagHandlers struct {
	db      *storage.DB
	ch      chan storage.DiagEvent
	dropped int64
}

// NewDiagHandlers builds the handler set and starts its background sink.
func NewDiagHandlers(db *storage.DB) *DiagHandlers {
	h := &DiagHandlers{db: db, ch: make(chan storage.DiagEvent, 2048)}
	go h.run()
	return h
}

// run accumulates events per fingerprint and flushes a batch every 2s, so DB
// writes are bounded by distinct-fingerprint count per interval, not event rate.
func (h *DiagHandlers) run() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	type accum struct {
		count  int
		latest storage.DiagEvent
	}
	pending := map[string]*accum{}
	flush := func() {
		if d := atomic.SwapInt64(&h.dropped, 0); d > 0 {
			slog.Warn("diag sink dropped events (buffer full)", slog.Int64("dropped", d))
		}
		if len(pending) == 0 {
			return
		}
		batch := make([]storage.DiagAccum, 0, len(pending))
		for _, a := range pending {
			batch = append(batch, storage.DiagAccum{Sample: a.latest, Count: a.count})
		}
		pending = map[string]*accum{}
		if err := h.db.InsertDiagBatch(batch); err != nil {
			slog.Error("diag batch write failed", slog.String("error", err.Error()))
		}
	}
	for {
		select {
		case e := <-h.ch:
			a := pending[e.Fingerprint]
			if a == nil {
				a = &accum{}
				pending[e.Fingerprint] = a
			}
			a.count++
			a.latest = e
		case <-ticker.C:
			flush()
		}
	}
}

// emit hands an event to the sink, dropping (and counting) if the buffer is full
// — diagnostics must never block or back-pressure the request path.
func (h *DiagHandlers) emit(e storage.DiagEvent) {
	if e.Fingerprint == "" {
		return
	}
	select {
	case h.ch <- e:
	default:
		atomic.AddInt64(&h.dropped, 1)
	}
}

// ---- fingerprinting ---------------------------------------------------------

var (
	diagHexRe   = regexp.MustCompile(`\b[0-9a-f]{8,}\b`)
	diagDigitRe = regexp.MustCompile(`\d+`)
)

// diagFingerprint groups similar occurrences: it normalises the first message
// line (lower-cased, hex ids and numbers masked) and hashes it with the source +
// route + status, mirroring the client-blind grouping a tracker does server-side.
func diagFingerprint(source, route string, status int, msg string) string {
	norm := strings.ToLower(strings.TrimSpace(strings.SplitN(msg, "\n", 2)[0]))
	norm = diagHexRe.ReplaceAllString(norm, "<id>")
	norm = diagDigitRe.ReplaceAllString(norm, "<n>")
	sum := sha256Hex(source + "|" + route + "|" + strconv.Itoa(status) + "|" + norm)
	return sum[:16]
}

// ---- capture middleware -----------------------------------------------------

// diagWriter captures the response status and the error value recorded by
// writeError, so the Capture middleware can record a 5xx with its real message
// and request_id without threading the request through every handler.
type diagWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
	err    error
}

func (d *diagWriter) WriteHeader(code int) {
	if !d.wrote {
		d.status = code
		d.wrote = true
	}
	d.ResponseWriter.WriteHeader(code)
}

func (d *diagWriter) Write(b []byte) (int, error) {
	if !d.wrote {
		d.status = http.StatusOK
		d.wrote = true
	}
	return d.ResponseWriter.Write(b)
}

func (d *diagWriter) recordError(err error) { d.err = err }

func (d *diagWriter) Flush() {
	if f, ok := d.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Capture records every recovered panic and every 5xx response as a diagnostic,
// correlated by request_id. It also acts as the recoverer for the API group
// (returning a sanitized 500). Must run inside RequireAuth (for the actor) and
// outside AuditMutations (so its writer is the base the statusWriter forwards to).
func (h *DiagHandlers) Capture(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dw := &diagWriter{ResponseWriter: w}
		defer func() {
			if rec := recover(); rec != nil && rec != http.ErrAbortHandler {
				stack := string(debug.Stack())
				h.recordPanic(r, rec, stack)
				slog.Error("panic recovered",
					slog.String("request_id", middleware.GetReqID(r.Context())),
					slog.String("path", r.URL.Path),
					slog.Any("panic", rec),
					slog.String("stack", stack),
				)
				if !dw.wrote {
					dw.Header().Set("Content-Type", "application/json")
					dw.WriteHeader(http.StatusInternalServerError)
					dw.Write([]byte(`{"error":"internal server error"}`)) //nolint:errcheck
				}
				return
			}
			if dw.status >= 500 {
				h.recordHTTPError(r, dw.status, dw.err)
			}
		}()
		next.ServeHTTP(dw, r)
	})
}

func diagRoutePattern(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			return p
		}
	}
	return r.URL.Path
}

func (h *DiagHandlers) recordHTTPError(r *http.Request, status int, err error) {
	pattern := diagRoutePattern(r)
	msg := "HTTP " + strconv.Itoa(status) + " " + pattern
	if err != nil {
		msg = err.Error()
	}
	h.emit(storage.DiagEvent{
		TS:          time.Now(),
		Level:       "error",
		Source:      "backend",
		Component:   pattern,
		Message:     clip(msg, 2000),
		Fingerprint: diagFingerprint("backend", pattern, status, msg),
		RequestID:   middleware.GetReqID(r.Context()),
		Actor:       actorName(r),
		Route:       r.Method + " " + pattern,
		StatusCode:  status,
	})
}

func (h *DiagHandlers) recordPanic(r *http.Request, rec any, stack string) {
	pattern := diagRoutePattern(r)
	msg := fmt.Sprintf("panic: %v", rec)
	h.emit(storage.DiagEvent{
		TS:          time.Now(),
		Level:       "error",
		Source:      "backend",
		Component:   pattern,
		Message:     clip(msg, 2000),
		Fingerprint: diagFingerprint("backend", pattern, 500, msg),
		RequestID:   middleware.GetReqID(r.Context()),
		Actor:       actorName(r),
		Route:       r.Method + " " + pattern,
		StatusCode:  http.StatusInternalServerError,
		Stack:       clip(stack, 8000),
	})
}

// ---- endpoints --------------------------------------------------------------

// Ingest accepts a frontend error report. Open to ANY authenticated user (viewers
// hit JS errors too); the fingerprint is computed server-side (client-blind). The
// sink's accumulation absorbs storms, so no per-request rate limit is needed here.
// POST /api/v1/diag/events.
func (h *DiagHandlers) Ingest(w http.ResponseWriter, r *http.Request) {
	type reportItem struct {
		Level     string         `json:"level"`
		Message   string         `json:"message"`
		Component string         `json:"component"`
		Stack     string         `json:"stack"`
		Release   string         `json:"release"`
		RequestID string         `json:"request_id"`
		URL       string         `json:"url"`
		Context   map[string]any `json:"context"`
	}
	// Reports arrive as a batch (the client flushes its queue in one beacon).
	var reports []reportItem
	if err := json.NewDecoder(r.Body).Decode(&reports); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	const maxBatch = 50
	if len(reports) > maxBatch {
		reports = reports[:maxBatch]
	}
	ua := clip(r.UserAgent(), 300)
	actor := actorName(r)
	for _, req := range reports {
		msg := clip(strings.TrimSpace(req.Message), 2000)
		if msg == "" {
			continue
		}
		level := req.Level
		if level != "warn" && level != "info" {
			level = "error"
		}
		comp := clip(req.Component, 200)
		ctxJSON := ""
		if len(req.Context) > 0 {
			if b, err := json.Marshal(req.Context); err == nil {
				ctxJSON = clip(string(b), 4000)
			}
		}
		h.emit(storage.DiagEvent{
			TS:          time.Now(),
			Level:       level,
			Source:      "frontend",
			Component:   comp,
			Message:     msg,
			Fingerprint: diagFingerprint("frontend", comp, 0, msg),
			RequestID:   clip(req.RequestID, 64),
			Actor:       actor,
			Route:       clip(req.URL, 300),
			Stack:       clip(req.Stack, 8000),
			Context:     ctxJSON,
			Release:     clip(req.Release, 64),
			UserAgent:   ua,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListGroups returns the grouped issue feed. Admin-only.
func (h *DiagHandlers) ListGroups(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	groups, err := h.db.QueryGroups(r.URL.Query().Get("status"), r.URL.Query().Get("source"), atoiDefault(r.URL.Query().Get("limit"), 100))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if groups == nil {
		groups = []storage.DiagGroup{}
	}
	writeJSON(w, groups)
}

// ListEvents returns occurrences, optionally filtered to one fingerprint. Admin-only.
func (h *DiagHandlers) ListEvents(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	events, err := h.db.QueryEvents(r.URL.Query().Get("fingerprint"), atoiDefault(r.URL.Query().Get("limit"), 100))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if events == nil {
		events = []storage.DiagEvent{}
	}
	writeJSON(w, events)
}

// Stats returns the dashboard headline numbers. Admin-only.
func (h *DiagHandlers) Stats(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	s, err := h.db.DiagStatsSummary()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, s)
}

// SetStatus resolves / mutes / reopens an issue group. Admin-only.
func (h *DiagHandlers) SetStatus(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	switch req.Status {
	case "open", "resolved", "muted":
	default:
		writeError(w, http.StatusBadRequest, errMsg("status must be open, resolved or muted"))
		return
	}
	if err := h.db.SetDiagGroupStatus(chi.URLParam(r, "fingerprint"), req.Status); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// ---- small helpers ----------------------------------------------------------

func clip(s string, max int) string {
	if len(s) > max {
		return s[:max]
	}
	return s
}

func atoiDefault(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return def
}

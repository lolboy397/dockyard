package api

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// slogRequestLogger logs one structured line per request (method, path, status,
// duration, request_id) at a level keyed to the status, and echoes the request id
// back as X-Request-Id so the browser can correlate a failed call to its server
// log. Replaces chi's text middleware.Logger. Uses chi's WrapResponseWriter so
// Flush/Hijack still pass through (WebSocket upgrades keep working).
func slogRequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := middleware.GetReqID(r.Context())
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		if reqID != "" {
			ww.Header().Set("X-Request-Id", reqID)
		}
		start := time.Now()
		defer func() {
			status := ww.Status()
			if status == 0 {
				status = http.StatusOK
			}
			level := slog.LevelInfo
			switch {
			case status >= 500:
				level = slog.LevelError
			case status >= 400:
				level = slog.LevelWarn
			}
			slog.LogAttrs(r.Context(), level, "http",
				slog.String("request_id", reqID),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", status),
				slog.Duration("dur", time.Since(start)),
			)
		}()
		next.ServeHTTP(ww, r)
	})
}

// slogRecoverer recovers panics, logs them with stack + request_id, and returns a
// sanitized 500 — internal detail never leaks to the client. Replaces chi's
// middleware.Recoverer.
func slogRecoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil && rec != http.ErrAbortHandler {
				slog.Error("panic recovered",
					slog.String("request_id", middleware.GetReqID(r.Context())),
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.Any("panic", rec),
					slog.String("stack", string(debug.Stack())),
				)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"error":"internal server error"}`)) //nolint:errcheck
			}
		}()
		next.ServeHTTP(w, r)
	})
}

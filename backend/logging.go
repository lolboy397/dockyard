package main

import (
	"log/slog"
	"os"
	"strings"
)

// initLogging installs a structured slog default logger — the foundation for the
// in-house diagnostics work. JSON by default (machine-parseable, ready for a log
// shipper or the future diagnostics sink); set LOG_FORMAT=text for a readable
// console during development. LOG_LEVEL is debug|info|warn|error (default info).
func initLogging() {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if strings.EqualFold(os.Getenv("LOG_FORMAT"), "text") {
		h = slog.NewTextHandler(os.Stderr, opts)
	} else {
		h = slog.NewJSONHandler(os.Stderr, opts)
	}
	slog.SetDefault(slog.New(h))
}

package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

type errorResponse struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// writeError sends a JSON error. 4xx messages are caller-facing and returned
// as-is. 5xx errors are INTERNAL (DB/Docker/filesystem failures) — their detail
// is logged server-side but NEVER returned to the client, which gets a generic
// message instead. (Previously every error's raw text was echoed to the client,
// leaking internal details on 5xx.)
func writeError(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if code >= 500 {
		slog.Error("request error", slog.Int("status", code), slog.String("error", err.Error()))
		json.NewEncoder(w).Encode(errorResponse{Error: "internal server error"}) //nolint:errcheck
		return
	}
	json.NewEncoder(w).Encode(errorResponse{Error: err.Error()}) //nolint:errcheck
}

func errMsg(msg string) error {
	return errors.New(msg)
}

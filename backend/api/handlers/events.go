package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

type EventHandlers struct {
	db *storage.DB
}

func NewEventHandlers(db *storage.DB) *EventHandlers {
	return &EventHandlers{db: db}
}

// GetEvents returns logged events, with global mute rules applied by default.
// Query params:
//   - kind:          restrict to a single event kind
//   - include_muted: when true, muted events are returned too (for "show muted")
//
// The total number of events currently hidden by the rules is returned in the
// X-Events-Muted-Count response header so the UI can surface it without a second
// request, while the body stays a plain Event array (its long-standing shape).
func (h *EventHandlers) GetEvents(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	includeMuted := r.URL.Query().Get("include_muted") == "true"
	limit := 200

	rules, err := h.db.EnabledEventFilters()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	events, err := h.db.GetEventsFiltered(kind, limit, rules, includeMuted)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if events == nil {
		events = []storage.Event{}
	}

	if muted, err := h.db.CountMutedEvents(rules); err == nil {
		w.Header().Set("X-Events-Muted-Count", strconv.Itoa(muted))
	}
	writeJSON(w, events)
}

// ListFilters returns all global event mute rules (readable by any authed user).
func (h *EventHandlers) ListFilters(w http.ResponseWriter, r *http.Request) {
	filters, err := h.db.ListEventFilters()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if filters == nil {
		filters = []storage.EventFilter{}
	}
	writeJSON(w, filters)
}

// CreateFilter adds a global mute rule (admin-only, enforced in Authorize).
func (h *EventHandlers) CreateFilter(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ObjectName string `json:"object_name"`
		Kind       string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	filter, err := h.db.CreateEventFilter(body.ObjectName, body.Kind)
	if errors.Is(err, storage.ErrEmptyEventFilter) {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, filter)
}

// UpdateFilter toggles a rule on or off (admin-only).
func (h *EventHandlers) UpdateFilter(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	if err := h.db.SetEventFilterEnabled(id, body.Enabled); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// DeleteFilter removes a rule (admin-only).
func (h *EventHandlers) DeleteFilter(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}
	if err := h.db.DeleteEventFilter(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

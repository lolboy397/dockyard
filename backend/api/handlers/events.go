package handlers

import (
	"net/http"

	"docker-manager/backend/storage"
)

type EventHandlers struct {
	db *storage.DB
}

func NewEventHandlers(db *storage.DB) *EventHandlers {
	return &EventHandlers{db: db}
}

// GetEvents returns logged events with optional kind and limit filters.
func (h *EventHandlers) GetEvents(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	limit := 200
	events, err := h.db.GetEvents(kind, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if events == nil {
		events = []storage.Event{}
	}
	writeJSON(w, events)
}

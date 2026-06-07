package handlers

import (
	"encoding/json"
	"net/http"

	"docker-manager/backend/storage"
	"docker-manager/backend/watcher"
)

type WatcherHandlers struct {
	db      *storage.DB
	watcher *watcher.Watcher
}

func NewWatcherHandlers(db *storage.DB, w *watcher.Watcher) *WatcherHandlers {
	return &WatcherHandlers{db: db, watcher: w}
}

// List returns all watched image configurations.
func (h *WatcherHandlers) List(w http.ResponseWriter, r *http.Request) {
	items, err := h.db.GetWatchedImages()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if items == nil {
		items = []storage.WatchedImage{}
	}
	writeJSON(w, items)
}

// Upsert adds or updates a watched image for a container.
func (h *WatcherHandlers) Upsert(w http.ResponseWriter, r *http.Request) {
	var body storage.WatchedImage
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if body.ContainerID == "" || body.Image == "" {
		writeError(w, http.StatusBadRequest, errMsg("container_id and image are required"))
		return
	}
	if body.CheckInterval <= 0 {
		body.CheckInterval = 300
	}
	if err := h.db.UpsertWatchedImage(body); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	h.watcher.Reload()
	writeJSON(w, map[string]string{"status": "ok"})
}

// Delete removes a container from the watch list.
func (h *WatcherHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("container_id")
	if id == "" {
		writeError(w, http.StatusBadRequest, errMsg("container_id is required"))
		return
	}
	if err := h.db.DeleteWatchedImage(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	h.watcher.Reload()
	writeJSON(w, map[string]string{"status": "removed"})
}

// CheckNow triggers an immediate update check. With ?container_id= it checks that
// one container synchronously and returns the refreshed record; otherwise it
// kicks off a background check of every watched image.
func (h *WatcherHandlers) CheckNow(w http.ResponseWriter, r *http.Request) {
	if id := r.URL.Query().Get("container_id"); id != "" {
		if err := h.watcher.CheckContainer(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		item, err := h.db.GetWatchedImage(id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, item)
		return
	}
	h.watcher.CheckNow()
	writeJSON(w, map[string]string{"status": "check triggered"})
}

// UpdateOne pulls the latest image and recreates a single watched container now.
// The container is replaced, so its ID changes — clients should refresh.
func (h *WatcherHandlers) UpdateOne(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("container_id")
	if id == "" {
		writeError(w, http.StatusBadRequest, errMsg("container_id is required"))
		return
	}
	if err := h.watcher.UpdateContainer(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "updated"})
}

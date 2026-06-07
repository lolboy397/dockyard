package handlers

import (
	"encoding/json"
	"net/http"

	"docker-manager/backend/storage"

	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
)

type VolumeHandlers struct {
	docker  *client.Client
	db      *storage.DB
	browser *volumeBrowser
	backup  *BackupService // shared with the background scheduler
}

func NewVolumeHandlers(cli *client.Client, db *storage.DB, bk *BackupService) *VolumeHandlers {
	return &VolumeHandlers{docker: cli, db: db, browser: newVolumeBrowser(cli), backup: bk}
}

// List returns all volumes.
func (h *VolumeHandlers) List(w http.ResponseWriter, r *http.Request) {
	resp, err := h.docker.VolumeList(r.Context(), volume.ListOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, resp)
}

// Inspect returns details of a single volume.
func (h *VolumeHandlers) Inspect(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	vol, err := h.docker.VolumeInspect(r.Context(), name)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, vol)
}

// Create creates a new volume.
func (h *VolumeHandlers) Create(w http.ResponseWriter, r *http.Request) {
	var body volume.CreateOptions
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	vol, err := h.docker.VolumeCreate(r.Context(), body)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, vol)
}

// Remove removes a volume.
func (h *VolumeHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	force := r.URL.Query().Get("force") == "true"
	if err := h.docker.VolumeRemove(r.Context(), name, force); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "removed"})
}

// Prune removes all unused volumes.
func (h *VolumeHandlers) Prune(w http.ResponseWriter, r *http.Request) {
	report, err := h.docker.VolumesPrune(r.Context(), filters.Args{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, report)
}

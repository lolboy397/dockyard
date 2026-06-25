package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"docker-manager/backend/storage"

	"github.com/docker/docker/api/types/container"
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

// Prune removes unused volumes and returns an itemized result. With ?all=true it
// also removes unused NAMED volumes; the Docker default removes only anonymous
// ones, which is why named volumes "rarely" disappeared before.
func (h *VolumeHandlers) Prune(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	all := r.URL.Query().Get("all") == "true"

	list, err := h.docker.VolumeList(ctx, volume.ListOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// volume name -> containers mounting it. Drives the skip reasons, so a failure
	// here would mislabel in-use volumes — fail fast.
	containers, err := h.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	usedBy := map[string][]string{}
	for _, c := range containers {
		cname := strings.TrimPrefix(firstName(c.Names), "/")
		for _, m := range c.Mounts {
			if m.Name != "" {
				usedBy[m.Name] = append(usedBy[m.Name], cname)
			}
		}
	}

	f := filters.NewArgs()
	if all {
		f.Add("all", "true")
	}
	report, err := h.docker.VolumesPrune(ctx, f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	deleted := map[string]struct{}{}
	for _, n := range report.VolumesDeleted {
		deleted[n] = struct{}{}
	}
	res := PruneResult{Kind: "volumes", Reclaimed: int64(report.SpaceReclaimed)}
	for _, v := range list.Volumes {
		if _, ok := deleted[v.Name]; ok {
			res.Removed = append(res.Removed, PruneItem{ID: shortID(v.Name), Name: v.Name})
			continue
		}
		if len(usedBy[v.Name]) > 0 {
			continue // in use — never a prune target, don't list as skipped
		}
		// Unused but not removed: a named volume under the anonymous-only default.
		// Surface the toggle so it isn't a mystery.
		if !all && !isAnonymousVolume(v.Name) {
			res.Skipped = append(res.Skipped, PruneItem{ID: shortID(v.Name), Name: v.Name, Reason: "named volume — enable “All unused” to remove"})
		}
	}
	writeJSON(w, res)
}

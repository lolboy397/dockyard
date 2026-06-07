package handlers

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
)

type ImageHandlers struct {
	docker *client.Client
}

func NewImageHandlers(cli *client.Client) *ImageHandlers {
	return &ImageHandlers{docker: cli}
}

// List returns all local images with accurate container-usage counts.
func (h *ImageHandlers) List(w http.ResponseWriter, r *http.Request) {
	images, err := h.docker.ImageList(r.Context(), image.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// Docker's /images/json always returns -1 for Containers; compute it ourselves.
	containers, err := h.docker.ContainerList(r.Context(), container.ListOptions{All: true})
	if err == nil {
		counts := make(map[string]int64, len(images))
		for _, c := range containers {
			counts[c.ImageID]++
		}
		for i := range images {
			if n, ok := counts[images[i].ID]; ok {
				images[i].Containers = n
			} else {
				images[i].Containers = 0
			}
		}
	}

	writeJSON(w, images)
}

// Inspect returns detailed information about an image.
func (h *ImageHandlers) Inspect(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, _, err := h.docker.ImageInspectWithRaw(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, info)
}

// Pull pulls an image from a registry and streams progress as newline-delimited JSON.
func (h *ImageHandlers) Pull(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Image string `json:"image"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Image == "" {
		writeError(w, http.StatusBadRequest, errMsg("image name is required"))
		return
	}

	rc, err := h.docker.ImagePull(r.Context(), body.Image, image.PullOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "application/x-ndjson")
	io.Copy(w, rc) //nolint:errcheck
}

// Remove deletes an image.
func (h *ImageHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	force := r.URL.Query().Get("force") == "true"
	pruneChildren := r.URL.Query().Get("prune") != "false"

	resp, err := h.docker.ImageRemove(r.Context(), id, image.RemoveOptions{
		Force:         force,
		PruneChildren: pruneChildren,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, resp)
}

// Tag tags an image.
func (h *ImageHandlers) Tag(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Tag string `json:"tag"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Tag == "" {
		writeError(w, http.StatusBadRequest, errMsg("tag is required"))
		return
	}
	if err := h.docker.ImageTag(r.Context(), id, body.Tag); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "tagged"})
}

// History returns the history of an image.
func (h *ImageHandlers) History(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	history, err := h.docker.ImageHistory(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, history)
}

// Prune removes unused images.
func (h *ImageHandlers) Prune(w http.ResponseWriter, r *http.Request) {
	dangling := r.URL.Query().Get("dangling") != "false"
	f := filters.NewArgs()
	if dangling {
		f.Add("dangling", "true")
	}
	report, err := h.docker.ImagesPrune(r.Context(), f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, report)
}

// Search searches Docker Hub for images matching a term.
func (h *ImageHandlers) Search(w http.ResponseWriter, r *http.Request) {
	term := r.URL.Query().Get("q")
	if term == "" {
		writeError(w, http.StatusBadRequest, errMsg("q query param is required"))
		return
	}
	results, err := h.docker.ImageSearch(r.Context(), term, registry.SearchOptions{Limit: 25})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, results)
}

package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

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

// Prune removes unused images and returns an itemized result. With ?all=true it
// removes every image not referenced by any container (docker image prune -a);
// the default removes only dangling (untagged) layers. The result lists exactly
// what was removed and what was skipped (with the reason) so the UI never has to
// guess.
func (h *ImageHandlers) Prune(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	all := r.URL.Query().Get("all") == "true"

	images, err := h.docker.ImageList(ctx, image.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Container usage drives both the candidate set and the skip reasons, so a
	// failure here would silently fabricate "has dependent child images" reasons
	// for images that are really in use — fail fast instead.
	containers, err := h.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// imageID -> names of containers (running OR stopped) referencing it. A
	// stopped container still protects its image from prune, which is why the old
	// tag-only client guess was wrong.
	usedBy := map[string][]string{}
	for _, c := range containers {
		name := strings.TrimPrefix(firstName(c.Names), "/")
		usedBy[c.ImageID] = append(usedBy[c.ImageID], name)
	}

	type target struct {
		id, name string
		size     int64
	}
	var targets []target        // images this scope intends to remove
	var leftoverTagged []target // tagged-but-unused images that dangling scope leaves behind
	for _, img := range images {
		dangling := imageIsDangling(img.RepoTags)
		inUse := len(usedBy[img.ID]) > 0
		name := imageRepoTag(img.RepoTags, img.ID)
		switch {
		case all && !inUse:
			targets = append(targets, target{img.ID, name, img.Size})
		case !all && dangling:
			targets = append(targets, target{img.ID, name, img.Size})
		case !all && !dangling && !inUse:
			leftoverTagged = append(leftoverTagged, target{img.ID, name, img.Size})
		}
	}

	// Atomic prune: Docker computes the full layer-dependency graph and removes in
	// the correct order in a single pass.
	f := filters.NewArgs()
	f.Add("dangling", strconv.FormatBool(!all))
	report, err := h.docker.ImagesPrune(ctx, f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	reclaimed := int64(report.SpaceReclaimed)
	deleted := map[string]struct{}{}
	for _, d := range report.ImagesDeleted {
		if d.Deleted != "" {
			deleted[trimSHA(d.Deleted)] = struct{}{}
		}
	}

	// Dangling scope only: removing a child layer can newly orphan its parent. One
	// extra pass clears it (the -a scope already handles parents atomically).
	if !all && len(report.ImagesDeleted) > 0 {
		if rep2, err2 := h.docker.ImagesPrune(ctx, f); err2 == nil {
			reclaimed += int64(rep2.SpaceReclaimed)
			for _, d := range rep2.ImagesDeleted {
				if d.Deleted != "" {
					deleted[trimSHA(d.Deleted)] = struct{}{}
				}
			}
		}
	}

	res := PruneResult{Kind: "images", Reclaimed: reclaimed}
	for _, t := range targets {
		if _, ok := deleted[trimSHA(t.id)]; ok {
			res.Removed = append(res.Removed, PruneItem{ID: shortID(t.id), Name: t.name, Size: t.size})
			continue
		}
		reason := "has dependent child images"
		if names := usedBy[t.id]; len(names) > 0 {
			reason = "in use by " + strings.Join(names, ", ")
		}
		res.Skipped = append(res.Skipped, PruneItem{ID: shortID(t.id), Name: t.name, Size: t.size, Reason: reason})
	}
	// Surface what dangling-only mode is leaving behind so "it rarely clears
	// everything" is never a mystery — the user can flip to All unused.
	for _, t := range leftoverTagged {
		res.Skipped = append(res.Skipped, PruneItem{ID: shortID(t.id), Name: t.name, Size: t.size, Reason: "unused — enable “All unused” to remove"})
	}
	writeJSON(w, res)
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

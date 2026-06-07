package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
)

type ContainerHandlers struct {
	docker *client.Client
}

func NewContainerHandlers(cli *client.Client) *ContainerHandlers {
	return &ContainerHandlers{docker: cli}
}

// List returns all containers (running + stopped by default, all=true for all states).
func (h *ContainerHandlers) List(w http.ResponseWriter, r *http.Request) {
	all := r.URL.Query().Get("all") == "true"
	containers, err := h.docker.ContainerList(r.Context(), container.ListOptions{All: all})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, containers)
}

// Inspect returns detailed information about a container.
func (h *ContainerHandlers) Inspect(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := h.docker.ContainerInspect(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, info)
}

// Start starts a container.
func (h *ContainerHandlers) Start(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.docker.ContainerStart(r.Context(), id, container.StartOptions{}); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "started"})
}

// Stop stops a container with a configurable timeout.
func (h *ContainerHandlers) Stop(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	timeout := 10
	if t := r.URL.Query().Get("timeout"); t != "" {
		if v, err := strconv.Atoi(t); err == nil {
			timeout = v
		}
	}
	stopOpts := container.StopOptions{Timeout: &timeout}
	if err := h.docker.ContainerStop(r.Context(), id, stopOpts); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "stopped"})
}

// Restart restarts a container.
func (h *ContainerHandlers) Restart(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	timeout := 10
	stopOpts := container.StopOptions{Timeout: &timeout}
	if err := h.docker.ContainerRestart(r.Context(), id, stopOpts); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "restarted"})
}

// Pause pauses a running container.
func (h *ContainerHandlers) Pause(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.docker.ContainerPause(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "paused"})
}

// Unpause unpauses a paused container.
func (h *ContainerHandlers) Unpause(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.docker.ContainerUnpause(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "unpaused"})
}

// Remove removes a container. Pass force=true to force-remove a running container.
func (h *ContainerHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	force := r.URL.Query().Get("force") == "true"
	removeVolumes := r.URL.Query().Get("volumes") == "true"
	opts := container.RemoveOptions{Force: force, RemoveVolumes: removeVolumes}
	if err := h.docker.ContainerRemove(r.Context(), id, opts); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "removed"})
}

// Rename renames a container.
func (h *ContainerHandlers) Rename(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeError(w, http.StatusBadRequest, errMsg("name is required"))
		return
	}
	if err := h.docker.ContainerRename(r.Context(), id, body.Name); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "renamed"})
}

// UpdateResources sets a running container's CPU/memory limits and restart
// policy in place via the Docker update API — no recreation needed.
func (h *ContainerHandlers) UpdateResources(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		CPUs          float64 `json:"cpus"`           // cores, e.g. 1.5; 0 = unlimited
		MemoryMB      int64   `json:"memory_mb"`      // MB; 0 = unlimited
		RestartPolicy string  `json:"restart_policy"` // no|always|unless-stopped|on-failure
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	switch body.RestartPolicy {
	case "", "no", "always", "unless-stopped", "on-failure":
	default:
		writeError(w, http.StatusBadRequest, errMsg("invalid restart policy"))
		return
	}

	mem := body.MemoryMB * 1024 * 1024
	res := container.Resources{NanoCPUs: int64(body.CPUs * 1e9), Memory: mem}
	if mem > 0 {
		res.MemorySwap = mem // disable swap so memoryswap >= memory holds
	}
	upd := container.UpdateConfig{Resources: res}
	if body.RestartPolicy != "" {
		upd.RestartPolicy = container.RestartPolicy{Name: container.RestartPolicyMode(body.RestartPolicy)}
	}
	if _, err := h.docker.ContainerUpdate(r.Context(), id, upd); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "updated"})
}

// Logs returns container logs. Supports tail, since, and timestamps query params.
// For streaming logs use the WebSocket endpoint.
func (h *ContainerHandlers) Logs(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "100"
	}
	since := r.URL.Query().Get("since")
	timestamps := r.URL.Query().Get("timestamps") == "true"

	opts := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     false,
		Tail:       tail,
		Since:      since,
		Timestamps: timestamps,
	}
	rc, err := h.docker.ContainerLogs(r.Context(), id, opts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.Copy(w, rc) //nolint:errcheck
}

// Stats returns a single (non-streaming) stats snapshot.
func (h *ContainerHandlers) Stats(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	resp, err := h.docker.ContainerStats(r.Context(), id, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, resp.Body) //nolint:errcheck
}

// Top returns the running processes inside a container.
func (h *ContainerHandlers) Top(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	args := r.URL.Query().Get("ps_args")
	resp, err := h.docker.ContainerTop(r.Context(), id, strings.Fields(args))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, resp)
}

// Exec runs a command inside a running container and returns its combined output.
func (h *ContainerHandlers) Exec(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Cmd []string `json:"cmd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Cmd) == 0 {
		writeError(w, http.StatusBadRequest, errMsg("cmd array is required"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	execID, err := h.docker.ContainerExecCreate(ctx, id, container.ExecOptions{
		Cmd:          body.Cmd,
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	attach, err := h.docker.ContainerExecAttach(ctx, execID.ID, container.ExecAttachOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer attach.Close()

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.Copy(w, attach.Reader) //nolint:errcheck
}

// Prune removes all stopped containers.
func (h *ContainerHandlers) Prune(w http.ResponseWriter, r *http.Request) {
	report, err := h.docker.ContainersPrune(r.Context(), filters.Args{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, report)
}

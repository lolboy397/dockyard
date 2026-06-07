package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
)

type NetworkHandlers struct {
	docker *client.Client
}

func NewNetworkHandlers(cli *client.Client) *NetworkHandlers {
	return &NetworkHandlers{docker: cli}
}

// List returns all networks.
func (h *NetworkHandlers) List(w http.ResponseWriter, r *http.Request) {
	networks, err := h.docker.NetworkList(r.Context(), network.ListOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, networks)
}

// Inspect returns details of a single network.
func (h *NetworkHandlers) Inspect(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := h.docker.NetworkInspect(r.Context(), id, network.InspectOptions{})
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, info)
}

// Create creates a new network. Expects JSON body: {"name":"mynet","driver":"bridge",...}
func (h *NetworkHandlers) Create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string            `json:"name"`
		Driver  string            `json:"driver"`
		Options map[string]string `json:"options"`
		Labels  map[string]string `json:"labels"`
		Internal   bool          `json:"internal"`
		Attachable bool          `json:"attachable"`
		EnableIPv6 bool          `json:"enable_ipv6"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, errMsg("name is required"))
		return
	}
	if body.Driver == "" {
		body.Driver = "bridge"
	}
	opts := network.CreateOptions{
		Driver:     body.Driver,
		Options:    body.Options,
		Labels:     body.Labels,
		Internal:   body.Internal,
		Attachable: body.Attachable,
		EnableIPv6: &body.EnableIPv6,
	}
	resp, err := h.docker.NetworkCreate(r.Context(), body.Name, opts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, resp)
}

// Remove removes a network.
func (h *NetworkHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.docker.NetworkRemove(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "removed"})
}

// Connect connects a container to a network.
func (h *NetworkHandlers) Connect(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		ContainerID string `json:"container_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ContainerID == "" {
		writeError(w, http.StatusBadRequest, errMsg("container_id is required"))
		return
	}
	if err := h.docker.NetworkConnect(r.Context(), id, body.ContainerID, nil); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "connected"})
}

// Disconnect disconnects a container from a network.
func (h *NetworkHandlers) Disconnect(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		ContainerID string `json:"container_id"`
		Force       bool   `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ContainerID == "" {
		writeError(w, http.StatusBadRequest, errMsg("container_id is required"))
		return
	}
	if err := h.docker.NetworkDisconnect(r.Context(), id, body.ContainerID, body.Force); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "disconnected"})
}

// Prune removes all unused networks.
func (h *NetworkHandlers) Prune(w http.ResponseWriter, r *http.Request) {
	report, err := h.docker.NetworksPrune(r.Context(), filters.Args{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, report)
}

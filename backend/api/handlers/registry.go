package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strconv"
	"time"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

// internalRegistryURL is the URL used by the backend to talk to the internal registry
// (via Docker network DNS). The push URL uses localhost because the Docker daemon
// (running on the host) reaches the registry via the exposed port 5000.
const internalRegistryURL = "http://registry:5000"
const internalRegistryPushHost = "localhost:5000"

// RegistryHandlers manages Docker registry configuration.
type RegistryHandlers struct {
	db *storage.DB
}

// NewRegistryHandlers creates a new RegistryHandlers instance.
func NewRegistryHandlers(db *storage.DB) *RegistryHandlers {
	return &RegistryHandlers{db: db}
}

// List returns all configured registries with live status.
func (h *RegistryHandlers) List(w http.ResponseWriter, r *http.Request) {
	regs, err := h.db.ListRegistries()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// Ensure the internal registry is always present.
	hasInternal := false
	for _, reg := range regs {
		if reg.URL == internalRegistryPushHost {
			hasInternal = true
			break
		}
	}
	if !hasInternal {
		h.db.UpsertRegistry(storage.Registry{ //nolint:errcheck
			Name:   "Internal",
			URL:    internalRegistryPushHost,
			Type:   "internal",
			Status: "unknown",
		})
		// Re-fetch
		regs, _ = h.db.ListRegistries()
	}

	// Probe each registry live.
	for i := range regs {
		regs[i].Status, regs[i].ImagesCount = h.probeRegistry(r.Context(), regs[i])
		h.db.UpdateRegistryStatus(regs[i].URL, regs[i].Status, regs[i].ImagesCount) //nolint:errcheck
	}

	if regs == nil {
		regs = []storage.Registry{}
	}
	writeJSON(w, regs)
}

// Add adds or authenticates a registry.
func (h *RegistryHandlers) Add(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		URL      string `json:"url"`
		Type     string `json:"type"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid body"))
		return
	}
	if req.URL == "" {
		writeError(w, http.StatusBadRequest, errMsg("url is required"))
		return
	}
	if req.Name == "" {
		req.Name = req.URL
	}
	if req.Type == "" {
		req.Type = "custom"
	}

	// Run docker login if credentials provided.
	if req.Username != "" && req.Password != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "docker", "login",
			"--username", req.Username,
			"--password-stdin",
			req.URL,
		)
		stdin, _ := cmd.StdinPipe()
		go func() {
			defer stdin.Close()
			io.WriteString(stdin, req.Password) //nolint:errcheck
		}()
		if out, err := cmd.CombinedOutput(); err != nil {
			writeError(w, http.StatusBadRequest, fmt.Errorf("docker login failed: %s", string(out)))
			return
		}
	}

	reg := storage.Registry{
		Name:     req.Name,
		URL:      req.URL,
		Type:     req.Type,
		Username: req.Username,
		Status:   "unknown",
	}
	if err := h.db.UpsertRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// Remove deletes a registry configuration and runs docker logout.
func (h *RegistryHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}

	// Find the registry to get the URL for docker logout.
	regs, _ := h.db.ListRegistries()
	for _, reg := range regs {
		if reg.ID == id {
			if reg.Type != "internal" {
				ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
				defer cancel()
				exec.CommandContext(ctx, "docker", "logout", reg.URL).Run() //nolint:errcheck
			}
			break
		}
	}

	if err := h.db.DeleteRegistry(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Images lists images in the internal registry.
func (h *RegistryHandlers) Images(w http.ResponseWriter, r *http.Request) {
	catalog, err := h.fetchRegistryCatalog(r.Context(), internalRegistryURL)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Errorf("registry unavailable: %v", err))
		return
	}

	type imageEntry struct {
		Name string   `json:"name"`
		Tags []string `json:"tags"`
	}
	var images []imageEntry
	for _, repo := range catalog {
		tags, _ := h.fetchRegistryTags(r.Context(), internalRegistryURL, repo)
		images = append(images, imageEntry{Name: repo, Tags: tags})
	}
	if images == nil {
		images = []imageEntry{}
	}
	writeJSON(w, images)
}

// probeRegistry pings a registry and returns (status, imageCount).
func (h *RegistryHandlers) probeRegistry(ctx context.Context, reg storage.Registry) (string, int) {
	probeURL := internalRegistryURL
	if reg.Type != "internal" {
		probeURL = "https://" + reg.URL
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(probeURL + "/v2/")
	if err != nil || (resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusUnauthorized) {
		return "unreachable", 0
	}
	resp.Body.Close()

	if reg.Type == "internal" {
		catalog, err := h.fetchRegistryCatalog(ctx, probeURL)
		if err != nil {
			return "connected", 0
		}
		return "connected", len(catalog)
	}
	return "connected", reg.ImagesCount
}

type catalogResponse struct {
	Repositories []string `json:"repositories"`
}

func (h *RegistryHandlers) fetchRegistryCatalog(ctx context.Context, baseURL string) ([]string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v2/_catalog", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("catalog returned %d", resp.StatusCode)
	}
	var cat catalogResponse
	if err := json.NewDecoder(resp.Body).Decode(&cat); err != nil {
		return nil, err
	}
	return cat.Repositories, nil
}

type tagsResponse struct {
	Tags []string `json:"tags"`
}

func (h *RegistryHandlers) fetchRegistryTags(ctx context.Context, baseURL, repo string) ([]string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/v2/%s/tags/list", baseURL, repo), nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tags returned %d", resp.StatusCode)
	}
	var tags tagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tags); err != nil {
		return nil, err
	}
	return tags.Tags, nil
}

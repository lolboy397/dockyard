package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

// BuildHandlers manages Docker image build jobs and build definitions.
type BuildHandlers struct {
	db      *storage.DB
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// NewBuildHandlers creates a new BuildHandlers instance.
func NewBuildHandlers(db *storage.DB) *BuildHandlers {
	return &BuildHandlers{
		db:      db,
		cancels: make(map[string]context.CancelFunc),
	}
}

// buildParams holds source + push configuration for a single build run.
type buildParams struct {
	SourceType     string // "inline" | "git"
	Dockerfile     string // inline source
	GitURL         string
	GitBranch      string
	DockerfilePath string // relative to repo root; default "Dockerfile"
	PushToRegistry bool
	RegistryURL    string
}

// -- Definition handlers -----------------------------------------------------

func (h *BuildHandlers) ListDefinitions(w http.ResponseWriter, r *http.Request) {
	defs, err := h.db.ListDefinitions()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if defs == nil {
		defs = []storage.BuildDefinition{}
	}
	writeJSON(w, defs)
}

func (h *BuildHandlers) GetDefinition(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	def, err := h.db.GetDefinition(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, def)
}

func (h *BuildHandlers) CreateDefinition(w http.ResponseWriter, r *http.Request) {
	var req storage.BuildDefinition
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid body"))
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, errMsg("name is required"))
		return
	}
	if req.SourceType == "" {
		req.SourceType = "inline"
	}
	if req.Tag == "" {
		req.Tag = "latest"
	}
	if req.GitBranch == "" {
		req.GitBranch = "main"
	}
	if req.DockerfilePath == "" {
		req.DockerfilePath = "Dockerfile"
	}
	req.ID = fmt.Sprintf("d%x", time.Now().UnixNano())
	if len(req.ID) > 12 {
		req.ID = req.ID[:12]
	}
	if err := h.db.CreateDefinition(&req); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, req)
}

func (h *BuildHandlers) UpdateDefinition(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req storage.BuildDefinition
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid body"))
		return
	}
	req.ID = id
	if err := h.db.UpdateDefinition(&req); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, req)
}

func (h *BuildHandlers) DeleteDefinition(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.db.DeleteDefinition(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *BuildHandlers) RunDefinition(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	def, err := h.db.GetDefinition(id)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("definition not found"))
		return
	}
	buildID := fmt.Sprintf("b%x", time.Now().UnixNano())
	if len(buildID) > 12 {
		buildID = buildID[:12]
	}
	defID := def.ID
	build := &storage.Build{
		ID:           buildID,
		Name:         def.Name,
		Tag:          def.Tag,
		Status:       "queued",
		InitiatedBy:  "user",
		DefinitionID: &defID,
	}
	if err := h.db.CreateBuild(build); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	params := buildParams{
		SourceType:     def.SourceType,
		Dockerfile:     def.Dockerfile,
		GitURL:         def.GitURL,
		GitBranch:      def.GitBranch,
		DockerfilePath: def.DockerfilePath,
		PushToRegistry: def.PushToRegistry,
		RegistryURL:    def.RegistryURL,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	h.mu.Lock()
	h.cancels[buildID] = cancel
	h.mu.Unlock()
	go h.runBuild(ctx, build, params)
	h.db.LogEvent("build_start", "user", "image", build.Name+":"+build.Tag, "", build.Name+":"+build.Tag, "") //nolint:errcheck
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, map[string]string{"id": buildID})
}

func (h *BuildHandlers) ListDefinitionRuns(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	runs, err := h.db.ListBuildsByDefinition(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if runs == nil {
		runs = []storage.Build{}
	}
	writeJSON(w, runs)
}

// -- Build run handlers -------------------------------------------------------

func (h *BuildHandlers) List(w http.ResponseWriter, r *http.Request) {
	builds, err := h.db.ListBuilds()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if builds == nil {
		builds = []storage.Build{}
	}
	writeJSON(w, builds)
}

func (h *BuildHandlers) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	build, err := h.db.GetBuild(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, build)
}

func (h *BuildHandlers) Submit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name           string `json:"name"`
		Tag            string `json:"tag"`
		Dockerfile     string `json:"dockerfile"`
		SourceType     string `json:"source_type"`
		GitURL         string `json:"git_url"`
		GitBranch      string `json:"git_branch"`
		DockerfilePath string `json:"dockerfile_path"`
		PushToRegistry bool   `json:"push_to_registry"`
		RegistryURL    string `json:"registry_url"`
		InitiatedBy    string `json:"initiated_by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid body"))
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, errMsg("name is required"))
		return
	}
	if req.SourceType == "" {
		req.SourceType = "inline"
	}
	if req.SourceType == "inline" && req.Dockerfile == "" {
		writeError(w, http.StatusBadRequest, errMsg("dockerfile is required for inline source"))
		return
	}
	if req.SourceType == "git" && req.GitURL == "" {
		writeError(w, http.StatusBadRequest, errMsg("git_url is required for git source"))
		return
	}
	if req.Tag == "" {
		req.Tag = "latest"
	}
	if req.GitBranch == "" {
		req.GitBranch = "main"
	}
	if req.DockerfilePath == "" {
		req.DockerfilePath = "Dockerfile"
	}
	if req.InitiatedBy == "" {
		req.InitiatedBy = "user"
	}
	id := fmt.Sprintf("b%x", time.Now().UnixNano())
	if len(id) > 12 {
		id = id[:12]
	}
	build := &storage.Build{
		ID:          id,
		Name:        req.Name,
		Tag:         req.Tag,
		Status:      "queued",
		InitiatedBy: req.InitiatedBy,
	}
	if err := h.db.CreateBuild(build); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	params := buildParams{
		SourceType:     req.SourceType,
		Dockerfile:     req.Dockerfile,
		GitURL:         req.GitURL,
		GitBranch:      req.GitBranch,
		DockerfilePath: req.DockerfilePath,
		PushToRegistry: req.PushToRegistry,
		RegistryURL:    req.RegistryURL,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	h.mu.Lock()
	h.cancels[id] = cancel
	h.mu.Unlock()
	go h.runBuild(ctx, build, params)
	h.db.LogEvent("build_start", "user", "image", build.Name+":"+build.Tag, "", build.Name+":"+build.Tag, "") //nolint:errcheck
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, map[string]string{"id": id})
}

func (h *BuildHandlers) Cancel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.mu.Lock()
	cancel, ok := h.cancels[id]
	h.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, errMsg("build not found or already finished"))
		return
	}
	cancel()
	w.WriteHeader(http.StatusNoContent)
}

func (h *BuildHandlers) ClearCache(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "builder", "prune", "-f")
	out, err := cmd.CombinedOutput()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("prune failed: %s", string(out)))
		return
	}
	writeJSON(w, map[string]string{"output": string(out)})
}

var stepRe = regexp.MustCompile(`Step (\d+)/(\d+)`)
var buildkitStepRe = regexp.MustCompile(`^#\d+ \[(\d+)/(\d+)\]`)

func (h *BuildHandlers) runBuild(ctx context.Context, build *storage.Build, params buildParams) {
	// Contain a panic to this goroutine and mark the build failed rather than
	// crashing the whole process and leaving the build stuck "running".
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[panic] build %v: %v", build.ID, r)
			h.db.UpdateBuildStatus(build.ID, "failed", fmt.Sprintf("build crashed: %v", r), 0, 0) //nolint:errcheck
		}
	}()
	defer func() {
		h.mu.Lock()
		delete(h.cancels, build.ID)
		h.mu.Unlock()
	}()

	if err := h.db.UpdateBuildStatus(build.ID, "running", "", 0, 0); err != nil {
		log.Printf("build %s: failed to mark running: %v", build.ID, err)
	}

	tmpDir, err := os.MkdirTemp("", "docker-build-*")
	if err != nil {
		h.db.UpdateBuildStatus(build.ID, "failed", //nolint:errcheck
			fmt.Sprintf("failed to create temp dir: %v", err), 0, 0)
		return
	}
	defer os.RemoveAll(tmpDir)

	var cloneLog string

	if params.SourceType == "git" {
		// Reject URLs/branches that could trigger git remote-helper RCE or
		// argument injection before they ever reach the clone command.
		if err := validateGitURL(params.GitURL); err != nil {
			h.db.UpdateBuildStatus(build.ID, "failed", "git clone failed: "+err.Error(), 0, 0) //nolint:errcheck
			return
		}
		if err := validateGitRef(params.GitBranch); err != nil {
			h.db.UpdateBuildStatus(build.ID, "failed", "git clone failed: "+err.Error(), 0, 0) //nolint:errcheck
			return
		}
		os.RemoveAll(tmpDir) //nolint:errcheck
		cloneArgs := []string{"clone", "--depth=1"}
		if params.GitBranch != "" {
			// "--branch=<v>" (with "=") binds the value so a "-"-leading branch
			// is not parsed as an option.
			cloneArgs = append(cloneArgs, "--branch="+params.GitBranch)
		}
		// "--" terminates option parsing for the positional URL/dir args.
		cloneArgs = append(cloneArgs, "--", params.GitURL, tmpDir)

		cloneCtx, cloneCancel := context.WithTimeout(ctx, 10*time.Minute)
		cloneCmd := exec.CommandContext(cloneCtx, "git", cloneArgs...)
		cloneCmd.Env = gitSafeEnv()
		cloneOut, cloneErr := cloneCmd.CombinedOutput()
		cloneCancel()
		cloneLog = fmt.Sprintf("[Dockyard] git clone %s @ %s\n%s\n", params.GitURL, params.GitBranch, string(cloneOut))
		if cloneErr != nil {
			h.db.UpdateBuildStatus(build.ID, "failed", //nolint:errcheck
				cloneLog+fmt.Sprintf("git clone failed: %v", cloneErr), 0, 0)
			return
		}
	} else {
		dfPath := filepath.Join(tmpDir, "Dockerfile")
		if err := os.WriteFile(dfPath, []byte(params.Dockerfile), 0600); err != nil {
			h.db.UpdateBuildStatus(build.ID, "failed", //nolint:errcheck
				fmt.Sprintf("failed to write Dockerfile: %v", err), 0, 0)
			return
		}
	}

	imageTag := build.Name + ":" + build.Tag
	var pushTag string
	if params.PushToRegistry && params.RegistryURL != "" {
		pushTag = strings.TrimRight(params.RegistryURL, "/") + "/" + build.Name + ":" + build.Tag
	}

	args := []string{"build", "-t", imageTag}
	if pushTag != "" {
		args = append(args, "-t", pushTag)
	}
	if params.SourceType == "git" && params.DockerfilePath != "" && params.DockerfilePath != "Dockerfile" {
		args = append(args, "-f", filepath.Join(tmpDir, params.DockerfilePath))
	}
	args = append(args, tmpDir)

	cmd := exec.CommandContext(ctx, "docker", args...)
	// Use the classic builder (not BuildKit): the daemon is reached through a
	// docker-socket-proxy, which doesn't forward BuildKit's /session endpoint.
	// The classic builder's "Step X/Y" output is parsed by the frontend.
	cmd.Env = append(os.Environ(), "DOCKER_BUILDKIT=0")
	stdoutPipe, _ := cmd.StdoutPipe()
	stderrPipe, _ := cmd.StderrPipe()

	startTime := time.Now()
	if err := cmd.Start(); err != nil {
		h.db.UpdateBuildStatus(build.ID, "failed", cloneLog+err.Error(), 0, 0) //nolint:errcheck
		return
	}

	lines := make(chan string, 512)
	var rg sync.WaitGroup
	rg.Add(2)
	go func() {
		defer rg.Done()
		sc := bufio.NewScanner(stdoutPipe)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()
	go func() {
		defer rg.Done()
		sc := bufio.NewScanner(stderrPipe)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()
	go func() {
		rg.Wait()
		close(lines)
	}()

	var logBuf strings.Builder
	logBuf.WriteString(cloneLog)
	var currentStep, totalSteps int
	var cacheHits int
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	flush := func() {
		progress := 0
		if totalSteps > 0 {
			progress = (currentStep * 100) / totalSteps
		}
		step := ""
		if totalSteps > 0 {
			step = fmt.Sprintf("%d of %d", currentStep, totalSteps)
		}
		durationMs := int(time.Since(startTime).Milliseconds())
		h.db.UpdateBuildProgress(build.ID, progress, step, currentStep, totalSteps, durationMs, logBuf.String()) //nolint:errcheck
	}

	for open := true; open; {
		select {
		case line, ok := <-lines:
			if !ok {
				open = false
				continue
			}
			logBuf.WriteString(line + "\n")
			if m := stepRe.FindStringSubmatch(line); m != nil {
				currentStep, _ = strconv.Atoi(m[1])
				totalSteps, _ = strconv.Atoi(m[2])
			}
			if m := buildkitStepRe.FindStringSubmatch(line); m != nil {
				cur, _ := strconv.Atoi(m[1])
				tot, _ := strconv.Atoi(m[2])
				if tot > totalSteps {
					totalSteps = tot
				}
				if cur > currentStep {
					currentStep = cur
				}
			}
			if strings.Contains(line, "CACHED") {
				cacheHits++
			}
		case <-ticker.C:
			flush()
		}
	}

	waitErr := cmd.Wait()
	durationMs := int(time.Since(startTime).Milliseconds())
	logStr := logBuf.String()

	cachePct := 0
	if totalSteps > 0 {
		cachePct = (cacheHits * 100) / totalSteps
	}

	switch {
	case ctx.Err() != nil:
		h.db.UpdateBuildStatus(build.ID, "cancelled", logStr, durationMs, cachePct) //nolint:errcheck
		h.db.LogEvent("build_cancelled", "user", "image", build.Name+":"+build.Tag, "", build.Name+":"+build.Tag, "") //nolint:errcheck
	case waitErr != nil:
		h.db.UpdateBuildStatus(build.ID, "failed", logStr, durationMs, cachePct) //nolint:errcheck
		h.db.LogEvent("build_failed", "system", "image", build.Name+":"+build.Tag, "", build.Name+":"+build.Tag, waitErr.Error()) //nolint:errcheck
	default:
		h.db.UpdateBuildStatus(build.ID, "succeeded", logStr, durationMs, cachePct) //nolint:errcheck
		h.db.LogEvent("build_success", "system", "image", build.Name+":"+build.Tag, "", build.Name+":"+build.Tag, //nolint:errcheck
			fmt.Sprintf("succeeded in %ds", durationMs/1000))
		if pushTag != "" {
			pushCtx, pushCancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer pushCancel()
			pushCmd := exec.CommandContext(pushCtx, "docker", "push", pushTag)
			if out, err := pushCmd.CombinedOutput(); err != nil {
				log.Printf("build %s: push to %s failed: %s %v", build.ID, pushTag, out, err)
			} else {
				log.Printf("build %s: pushed %s", build.ID, pushTag)
			}
		}
	}
}

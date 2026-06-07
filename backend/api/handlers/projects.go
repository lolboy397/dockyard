package handlers

import (
	"archive/zip"
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
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
	"github.com/gorilla/websocket"
)

const (
	projectsRoot   = "/data/projects"
	maxUploadBytes = 512 << 20 // 512 MB
)

// skipDirs are directories ignored when building the file tree.
var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, "vendor": true,
	"__pycache__": true, ".venv": true, "venv": true,
	"dist": true, "build": true, "target": true, ".next": true,
}

// broadcastHub fans out build-log lines to WebSocket subscribers in real time.
type broadcastHub struct {
	mu              sync.Mutex
	history         []string
	subs            map[chan string]struct{}
	done            bool
	doneStatus      string
	donePortConflict string // non-empty when run failed due to a port conflict
}

func newBroadcastHub() *broadcastHub {
	return &broadcastHub{subs: make(map[chan string]struct{})}
}

func (h *broadcastHub) publish(line string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.history = append(h.history, line)
	for ch := range h.subs {
		select {
		case ch <- line:
		default:
		}
	}
}

func (h *broadcastHub) subscribe() ([]string, chan string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	snap := make([]string, len(h.history))
	copy(snap, h.history)
	if h.done {
		return snap, nil, true
	}
	ch := make(chan string, 512)
	h.subs[ch] = struct{}{}
	return snap, ch, false
}

// portConflictRe matches Docker's port-binding error messages and captures the HOST port.
// Handles:
//   exposing port TCP 0.0.0.0:8080 -> ...       (Windows / Linux Docker)
//   Bind for 0.0.0.0:8080 failed                (Linux Docker)
//   listen tcp 0.0.0.0:8080: bind               (Linux Docker)
var portConflictRe = regexp.MustCompile(`(?:exposing port TCP|Bind for|listen tcp\d*)\s+[\d.]+:([1-9][0-9]{1,4})`)

// detectPortConflict checks whether runOutput (the combined stdout+stderr of a
// failed `docker run` or `docker compose up`) describes a host-port binding
// conflict and returns the conflicting host port string.
//
// Strategy: prefer matching against the project's own declared host ports (most
// reliable), then fall back to the general Docker error regex.
func detectPortConflict(runOutput string, proj *storage.Project) string {
	if runOutput == "" {
		return ""
	}
	lower := strings.ToLower(runOutput)
	if !strings.Contains(lower, "bind") && !strings.Contains(lower, "ports are not available") && !strings.Contains(lower, "address already in use") && !strings.Contains(lower, "port is already allocated") {
		return ""
	}

	// 1. Check the project's own declared port mappings: HOST:CONTAINER.
	//    If any host port appears in the error output, that's the conflict.
	for _, mapping := range parsePorts(proj.Ports) {
		// mapping is "HOST:CONTAINER" or just "PORT"
		parts := strings.SplitN(strings.TrimSpace(mapping), ":", 2)
		hostPort := strings.TrimLeft(parts[0], "\"'")
		if hostPort != "" && strings.Contains(runOutput, ":"+hostPort) {
			return hostPort
		}
	}

	// 2. For compose projects, scan the compose file's host ports.
	if proj.Type == "compose" {
		composePath := findComposeFile(proj.Path)
		if data, err := os.ReadFile(composePath); err == nil {
			// Extract all host ports from lines like: - "8080:80" or - 8080:80
			portLineRe := regexp.MustCompile(`["']?(\d+):(\d+)["']?`)
			for _, m := range portLineRe.FindAllStringSubmatch(string(data), -1) {
				hostPort := m[1]
				if strings.Contains(runOutput, ":"+hostPort) {
					return hostPort
				}
			}
		}
	}

	// 3. Fall back to the general regex.
	if m := portConflictRe.FindStringSubmatch(runOutput); m != nil {
		return m[1]
	}
	return ""
}

func (h *broadcastHub) unsubscribe(ch chan string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.done {
		delete(h.subs, ch)
	}
}

func (h *broadcastHub) finish(status, portConflict string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.done = true
	h.doneStatus = status
	h.donePortConflict = portConflict
	for ch := range h.subs {
		close(ch)
	}
	h.subs = make(map[chan string]struct{})
}

// ── Delete-progress streaming ──────────────────────────────────────────────────

// delStep names one stage of a project teardown, shown as a checklist row.
type delStep struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// delEvent is a single progress frame sent to the delete WebSocket.
//
//	{"type":"plan","steps":[...],"total":4}              — the planned steps
//	{"type":"step","index":1,"total":4,"key":"...","state":"running|done|failed"}
//	{"type":"done"}                                       — teardown finished
//	{"type":"error","data":"..."}                        — a fatal step failed
type delEvent struct {
	Type  string    `json:"type"`
	Steps []delStep `json:"steps,omitempty"`
	Index int       `json:"index,omitempty"`
	Total int       `json:"total,omitempty"`
	Key   string    `json:"key,omitempty"`
	State string    `json:"state,omitempty"`
	Data  string    `json:"data,omitempty"`
}

// deleteHub fans out delete-progress events to WebSocket subscribers, buffering
// history so a client that connects mid-teardown still sees every prior step.
type deleteHub struct {
	mu     sync.Mutex
	events []delEvent
	subs   map[chan delEvent]struct{}
	done   bool
}

func newDeleteHub() *deleteHub {
	return &deleteHub{subs: make(map[chan delEvent]struct{})}
}

func (h *deleteHub) publish(ev delEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events = append(h.events, ev)
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (h *deleteHub) subscribe() ([]delEvent, chan delEvent, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	snap := make([]delEvent, len(h.events))
	copy(snap, h.events)
	if h.done {
		return snap, nil, true
	}
	ch := make(chan delEvent, 64)
	h.subs[ch] = struct{}{}
	return snap, ch, false
}

func (h *deleteHub) unsubscribe(ch chan delEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.done {
		delete(h.subs, ch)
	}
}

func (h *deleteHub) finish() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.done = true
	for ch := range h.subs {
		close(ch)
	}
	h.subs = make(map[chan delEvent]struct{})
}

// ProjectHandlers manages local project upload, build and run.
type ProjectHandlers struct {
	db         *storage.DB
	mu         sync.Mutex
	cancels    map[int64]context.CancelFunc
	hubs       sync.Map // int64 → *broadcastHub  (build-log streaming)
	deleteHubs sync.Map // int64 → *deleteHub     (delete-progress streaming)
}

// NewProjectHandlers creates a new ProjectHandlers.
func NewProjectHandlers(db *storage.DB) *ProjectHandlers {
	return &ProjectHandlers{
		db:      db,
		cancels: make(map[int64]context.CancelFunc),
	}
}

// ── File tree types ───────────────────────────────────────────────────────────

// FileNode represents a single node in a project's file tree.
type FileNode struct {
	Name     string     `json:"name"`
	Type     string     `json:"type"` // "file" | "dir"
	Size     int64      `json:"size,omitempty"`
	Lines    int        `json:"lines,omitempty"`
	Children []FileNode `json:"children,omitempty"`
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// Upload accepts either:
//   - a multipart "archive" field containing a .zip file, or
//   - multiple "files" fields where each entry's filename encodes its relative
//     path within the project (e.g. "src/main.go", "Dockerfile").
//
// Optional form fields: "name", "description", "ports".
func (h *ProjectHandlers) Upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("parse form: %w", err))
		return
	}

	name := strings.TrimSpace(r.FormValue("name"))
	description := r.FormValue("description")
	if name == "" {
		writeError(w, http.StatusBadRequest, errMsg("name is required"))
		return
	}
	// Sanitise name: only letters, digits, hyphens, underscores.
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_') {
			writeError(w, http.StatusBadRequest, errMsg("name may only contain letters, digits, hyphens and underscores"))
			return
		}
	}

	destDir := filepath.Join(projectsRoot, name)
	if _, statErr := os.Stat(destDir); statErr == nil {
		writeError(w, http.StatusConflict, errMsg("a project with that name already exists"))
		return
	}
	if err := os.MkdirAll(destDir, 0755); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("create project dir: %w", err))
		return
	}

	archiveFile, archiveHeader, archiveErr := r.FormFile("archive")
	hasFiles := len(r.MultipartForm.File["files"]) > 0

	if archiveErr != nil && !hasFiles {
		os.RemoveAll(destDir) //nolint:errcheck
		writeError(w, http.StatusBadRequest, errMsg("provide either an 'archive' (.zip) or project 'files'"))
		return
	}

	if archiveErr == nil {
		// ── ZIP path ──────────────────────────────────────────────────────────
		defer archiveFile.Close()
		if !strings.HasSuffix(strings.ToLower(archiveHeader.Filename), ".zip") {
			os.RemoveAll(destDir) //nolint:errcheck
			writeError(w, http.StatusBadRequest, errMsg("only .zip archives are supported"))
			return
		}

		tmp, err := os.CreateTemp("", "project-upload-*.zip")
		if err != nil {
			os.RemoveAll(destDir) //nolint:errcheck
			writeError(w, http.StatusInternalServerError, fmt.Errorf("temp file: %w", err))
			return
		}
		defer os.Remove(tmp.Name())
		defer tmp.Close()

		size, err := io.Copy(tmp, archiveFile)
		if err != nil {
			os.RemoveAll(destDir) //nolint:errcheck
			writeError(w, http.StatusInternalServerError, fmt.Errorf("save upload: %w", err))
			return
		}
		tmp.Seek(0, io.SeekStart) //nolint:errcheck

		zr, err := zip.NewReader(tmp, size)
		if err != nil {
			os.RemoveAll(destDir) //nolint:errcheck
			writeError(w, http.StatusBadRequest, fmt.Errorf("invalid zip: %w", err))
			return
		}

		// Detect single-root folder prefix (e.g. GitHub archive my-repo-main/).
		prefix := zipSingleRoot(zr)
		if err := extractZip(zr, destDir, prefix); err != nil {
			os.RemoveAll(destDir) //nolint:errcheck
			writeError(w, http.StatusInternalServerError, fmt.Errorf("extract zip: %w", err))
			return
		}
	} else {
		// ── Multi-file path ────────────────────────────────────────────────
		if err := receiveFiles(r, destDir); err != nil {
			os.RemoveAll(destDir) //nolint:errcheck
			writeError(w, http.StatusInternalServerError, fmt.Errorf("receive files: %w", err))
			return
		}
	}

	projectType := detectProjectType(destDir)
	imageTag := "project-" + strings.ToLower(name) + ":latest"
	ports := r.FormValue("ports")

	proj, err := h.db.CreateProject(storage.Project{
		Name:        name,
		Description: description,
		Path:        destDir,
		Type:        projectType,
		ImageTag:    imageTag,
		Ports:       ports,
	})
	if err != nil {
		os.RemoveAll(destDir) //nolint:errcheck
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	// Initialise a hosted git repo for this project (non-fatal if it fails).
	initCtx, initCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer initCancel()
	if initErr := initProjectRepo(initCtx, name, destDir); initErr != nil {
		log.Printf("[project %s] git init skipped: %v", name, initErr)
	} else if gitRepo, repoErr := h.db.CreateGitRepo(storage.GitRepo{Name: name, Path: destDir}); repoErr != nil {
		log.Printf("[project %s] create git repo record skipped: %v", name, repoErr)
	} else if linkErr := h.db.LinkProjectRepo(proj.ID, gitRepo.ID); linkErr != nil {
		log.Printf("[project %s] link project repo skipped: %v", name, linkErr)
	} else {
		proj.RepoID = &gitRepo.ID
	}

	w.WriteHeader(http.StatusCreated)
	h.db.LogEvent("project_create", "user", "project", proj.Name, "", "", "") //nolint:errcheck
	writeJSON(w, proj)
}

// receiveFiles writes the "files" multipart entries into destDir, using each
// entry's filename as the relative path within the project. Path traversal
// attempts are silently skipped.
func receiveFiles(r *http.Request, destDir string) error {
	fileHeaders := r.MultipartForm.File["files"]
	if len(fileHeaders) == 0 {
		return fmt.Errorf("no files provided")
	}
	destDir = filepath.Clean(destDir)
	for _, fh := range fileHeaders {
		// Go's multipart.FileHeader.Filename has filepath.Base() applied per
		// RFC 7578, which strips all directory components. Recover the full
		// relative path the client sent by reading the raw Content-Disposition
		// header directly.
		rawName := fh.Filename
		if cd := fh.Header.Get("Content-Disposition"); cd != "" {
			if _, params, err := mime.ParseMediaType(cd); err == nil {
				if v := params["filename"]; v != "" {
					rawName = v
				}
			}
		}
		relPath := filepath.FromSlash(rawName)
		clean := filepath.Clean(relPath)
		// Guard against path traversal attacks.
		if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
			continue
		}
		dest := filepath.Join(destDir, clean)
		if !strings.HasPrefix(filepath.Clean(dest), destDir+string(filepath.Separator)) &&
			filepath.Clean(dest) != destDir {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}
		src, err := fh.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(dest)
		if err != nil {
			src.Close()
			return err
		}
		_, copyErr := io.Copy(out, src)
		src.Close()
		out.Close()
		if copyErr != nil {
			return copyErr
		}
	}
	return nil
}

// List returns all projects.
func (h *ProjectHandlers) List(w http.ResponseWriter, r *http.Request) {
	projs, err := h.db.ListProjects()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if projs == nil {
		projs = []storage.Project{}
	}
	// Strip logs from list response (they can be large).
	for i := range projs {
		projs[i].BuildLog = ""
		projs[i].RunLog = ""
		projs[i].Branch = getProjectBranch(projs[i].Path)
	}
	writeJSON(w, projs)
}

// Get returns a single project including logs.
func (h *ProjectHandlers) Get(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	proj.Branch = getProjectBranch(proj.Path)
	writeJSON(w, proj)
}

// FileContent returns the content of a single file within a project directory.
func (h *ProjectHandlers) FileContent(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}

	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		writeError(w, http.StatusBadRequest, errMsg("path is required"))
		return
	}

	// Security: sanitize to prevent path traversal.
	clean := filepath.Clean(filepath.FromSlash(relPath))
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		writeError(w, http.StatusBadRequest, errMsg("invalid path"))
		return
	}
	fullPath := filepath.Join(proj.Path, clean)
	projBase := filepath.Clean(proj.Path) + string(filepath.Separator)
	if !strings.HasPrefix(filepath.Clean(fullPath)+string(filepath.Separator), projBase) {
		writeError(w, http.StatusBadRequest, errMsg("invalid path"))
		return
	}

	info, statErr := os.Stat(fullPath)
	if statErr != nil {
		writeError(w, http.StatusNotFound, errMsg("file not found"))
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, errMsg("path is a directory"))
		return
	}
	const maxSize = 512 * 1024 // 512 KB
	if info.Size() > maxSize {
		writeError(w, http.StatusRequestEntityTooLarge, errMsg("file too large to preview"))
		return
	}

	data, readErr := os.ReadFile(fullPath)
	if readErr != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("read file: %w", readErr))
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(data) //nolint:errcheck
}

// Delete tears a project down asynchronously and streams per-step progress over
// the project's delete WebSocket. It always removes the project's containers and
// networks, the DB record and the project files; pass ?purge=true to also remove
// the built image and volumes. Returns 202 immediately — the client connects to
// /ws/projects/{id}/delete-progress to watch the steps.
func (h *ProjectHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	purge := r.URL.Query().Get("purge") == "true"

	hub := newDeleteHub()
	h.deleteHubs.Store(proj.ID, hub)

	go h.runDelete(proj, purge, hub)

	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]string{"status": "deleting"})
}

// delTask pairs a checklist step with the action that performs it.
type delTask struct {
	step   delStep
	fatal  bool // when true, a failure aborts the teardown and reports an error
	action func(ctx context.Context) error
}

// runDelete executes a project teardown step by step, publishing progress to hub.
func (h *ProjectHandlers) runDelete(proj *storage.Project, purge bool, hub *deleteHub) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[panic] project %s delete: %v", proj.Name, rec)
			hub.publish(delEvent{Type: "error", Data: fmt.Sprintf("delete crashed: %v", rec)})
		}
		hub.finish()
		// Keep the hub briefly so a late or reconnecting client can still read the
		// final state, then drop it.
		time.AfterFunc(30*time.Second, func() { h.deleteHubs.Delete(proj.ID) })
	}()

	h.db.LogEvent("project_delete_start", "user", "project", proj.Name, "", "", "") //nolint:errcheck

	// Cancel any in-progress build/run for this project so its files aren't held.
	h.mu.Lock()
	if cancel, ok := h.cancels[proj.ID]; ok {
		cancel()
		delete(h.cancels, proj.ID)
	}
	h.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()

	tasks := h.planDeleteTasks(proj, purge)
	steps := make([]delStep, len(tasks))
	for i, t := range tasks {
		steps[i] = t.step
	}
	hub.publish(delEvent{Type: "plan", Steps: steps, Total: len(steps)})

	// Floor each step's visible duration so fast stages (DB row, files) still
	// register as a distinct step in the UI instead of flashing past.
	const minStepDuration = 350 * time.Millisecond

	for i, t := range tasks {
		hub.publish(delEvent{Type: "step", Index: i + 1, Total: len(tasks), Key: t.step.Key, State: "running"})
		start := time.Now()
		err := t.action(ctx)
		if d := time.Since(start); d < minStepDuration {
			time.Sleep(minStepDuration - d)
		}

		state := "done"
		if err != nil && !isBenignTeardownErr(err) {
			log.Printf("[project %s] delete step %q: %v", proj.Name, t.step.Key, err)
			if t.fatal {
				hub.publish(delEvent{Type: "step", Index: i + 1, Total: len(tasks), Key: t.step.Key, State: "failed"})
				hub.publish(delEvent{Type: "error", Data: err.Error()})
				return
			}
			state = "failed" // best-effort step genuinely failed — surface it but keep going
		}
		hub.publish(delEvent{Type: "step", Index: i + 1, Total: len(tasks), Key: t.step.Key, State: state})
	}

	h.db.LogEvent("project_delete", "user", "project", proj.Name, "", "", "") //nolint:errcheck
	hub.publish(delEvent{Type: "done"})
	log.Printf("[project %s] deleted", proj.Name)
}

// planDeleteTasks builds the ordered teardown plan for a project. Docker stages
// vary by project type; the DB record and file removal always run last.
func (h *ProjectHandlers) planDeleteTasks(proj *storage.Project, purge bool) []delTask {
	var tasks []delTask

	switch proj.Type {
	case "compose":
		composePath := findComposeFile(proj.Path)
		pname := composeProjectName(proj.Name)
		// `compose down` removes the project's containers and default network.
		tasks = append(tasks, delTask{
			step: delStep{Key: "containers", Label: "Stopping & removing containers"},
			action: func(ctx context.Context) error {
				return runQuiet(ctx, proj.Path, "docker", "compose", "-f", composePath, "-p", pname, "down")
			},
		})
		if purge {
			tasks = append(tasks,
				delTask{
					step: delStep{Key: "volumes", Label: "Removing volumes"},
					action: func(ctx context.Context) error {
						return runQuiet(ctx, proj.Path, "docker", "compose", "-f", composePath, "-p", pname, "down", "--volumes")
					},
				},
				// --rmi local removes only images compose built for this project,
				// leaving shared pulled base images (postgres:16, node:20, …) intact.
				delTask{
					step: delStep{Key: "images", Label: "Removing images"},
					action: func(ctx context.Context) error {
						return runQuiet(ctx, proj.Path, "docker", "compose", "-f", composePath, "-p", pname, "down", "--rmi", "local")
					},
				},
			)
		}
	case "dockerfile":
		containerName := "project-" + strings.ToLower(proj.Name)
		tasks = append(tasks, delTask{
			step: delStep{Key: "containers", Label: "Stopping & removing container"},
			action: func(ctx context.Context) error {
				exec.CommandContext(ctx, "docker", "stop", containerName).Run() //nolint:errcheck
				// -v also drops the container's anonymous volumes.
				return runQuiet(ctx, "", "docker", "rm", "-fv", containerName)
			},
		})
		if purge && proj.ImageTag != "" {
			tasks = append(tasks, delTask{
				step: delStep{Key: "images", Label: "Removing image"},
				action: func(ctx context.Context) error {
					return runQuiet(ctx, "", "docker", "rmi", "--no-prune", proj.ImageTag)
				},
			})
		}
	}

	tasks = append(tasks,
		delTask{
			step:  delStep{Key: "record", Label: "Removing project record"},
			fatal: true,
			action: func(ctx context.Context) error {
				return h.db.DeleteProject(proj.ID)
			},
		},
		delTask{
			step: delStep{Key: "files", Label: "Deleting project files"},
			action: func(ctx context.Context) error {
				return os.RemoveAll(proj.Path)
			},
		},
	)

	return tasks
}

// runQuiet runs a command, returning an error that includes its combined output.
func runQuiet(ctx context.Context, dir, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// isBenignTeardownErr reports whether a teardown error just means the resource
// was already gone (e.g. a never-run project has no container to remove), in
// which case the step should still be reported as done rather than failed.
func isBenignTeardownErr(err error) bool {
	if err == nil {
		return true
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "no such") ||
		strings.Contains(s, "not found") ||
		strings.Contains(s, "is not running")
}

// blockPrivilegedProjectCompose answers the request with 403 and returns true
// when a compose project's compose file uses a host-root-equivalent directive
// and the caller is not an admin (same policy as stack deploy).
func (h *ProjectHandlers) blockPrivilegedProjectCompose(w http.ResponseWriter, r *http.Request, proj *storage.Project) bool {
	if proj.Type != "compose" {
		return false
	}
	data, err := os.ReadFile(findComposeFile(proj.Path))
	if err != nil {
		return false
	}
	return requireAdminForPrivilegedCompose(w, r, string(data))
}

// Build triggers an async image build for the project.
func (h *ProjectHandlers) Build(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	if proj.Status == "building" {
		writeError(w, http.StatusConflict, errMsg("build already in progress"))
		return
	}
	if proj.Type == "unknown" {
		writeError(w, http.StatusBadRequest, errMsg("project type unknown — no Dockerfile or docker-compose.yml detected"))
		return
	}
	if h.blockPrivilegedProjectCompose(w, r, proj) {
		return
	}

	h.db.UpdateProjectStatus(proj.ID, "building", "") //nolint:errcheck
	h.db.UpdateProjectBuildLog(proj.ID, "")           //nolint:errcheck

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	h.mu.Lock()
	h.cancels[proj.ID] = cancel
	h.mu.Unlock()

	go h.runBuild(ctx, proj)
	writeJSON(w, map[string]string{"status": "building"})
}

// Run starts the project containers (after a successful build).
func (h *ProjectHandlers) Run(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	if proj.Status == "running" {
		writeError(w, http.StatusConflict, errMsg("project is already running"))
		return
	}
	if proj.Status == "building" {
		writeError(w, http.StatusConflict, errMsg("build is in progress"))
		return
	}
	if proj.Type == "unknown" {
		writeError(w, http.StatusBadRequest, errMsg("project type unknown"))
		return
	}
	if h.blockPrivilegedProjectCompose(w, r, proj) {
		return
	}

	h.db.UpdateProjectStatus(proj.ID, "building", "") //nolint:errcheck
	h.db.UpdateProjectBuildLog(proj.ID, "")           //nolint:errcheck
	h.db.UpdateProjectRunLog(proj.ID, "")             //nolint:errcheck

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	h.mu.Lock()
	h.cancels[proj.ID] = cancel
	h.mu.Unlock()

	go h.runBuildAndStart(ctx, proj)
	writeJSON(w, map[string]string{"status": "building"})
}

// Stop halts running containers for the project.
func (h *ProjectHandlers) Stop(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}

	// Cancel in-progress build/run if any.
	h.mu.Lock()
	if cancel, ok := h.cancels[proj.ID]; ok {
		cancel()
		delete(h.cancels, proj.ID)
	}
	h.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	h.stopContainers(ctx, proj)
	h.db.LogEvent("project_stop", "user", "project", proj.Name, "", "", "") //nolint:errcheck
	writeJSON(w, map[string]string{"status": "stopped"})
}

// Logs returns the current build and run logs for a project.
func (h *ProjectHandlers) Logs(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	writeJSON(w, map[string]string{
		"build_log": proj.BuildLog,
		"run_log":   proj.RunLog,
		"status":    proj.Status,
	})
}

// Files returns a recursive file tree for the project (max 3 levels deep).
func (h *ProjectHandlers) Files(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	tree := buildFileTree(proj.Path, proj.Path, 0, 3)
	writeJSON(w, tree)
}

// UpdatePorts saves port-mapping configuration for a Dockerfile project.
func (h *ProjectHandlers) UpdatePorts(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	var body struct {
		Ports string `json:"ports"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid body: %w", err))
		return
	}
	if err := h.db.UpdateProjectPorts(proj.ID, body.Ports); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	proj.Ports = body.Ports
	writeJSON(w, proj)
}

// parsePorts splits a comma-separated port-mapping string into individual mappings.
func parsePorts(ports string) []string {
	var result []string
	for _, p := range strings.Split(ports, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

// parseComposePorts returns a map of serviceName→containerPort for every service
// in the compose YAML that exposes the given host port.
func parseComposePorts(content, hostPort string) map[string]string {
	result := make(map[string]string)
	portRe := regexp.MustCompile(`["']?` + regexp.QuoteMeta(hostPort) + `:([\d]+(?:/\w+)?)["']?`)
	svcRe := regexp.MustCompile(`^  ([A-Za-z0-9_-]+):\s*$`)

	var currentService string
	inPorts := false
	for _, line := range strings.Split(content, "\n") {
		if m := svcRe.FindStringSubmatch(line); m != nil {
			currentService = m[1]
			inPorts = false
			continue
		}
		if strings.TrimSpace(line) == "ports:" {
			inPorts = true
			continue
		}
		// A non-list key at 4-space indent closes the ports block.
		trimmed := strings.TrimLeft(line, " ")
		spaces := len(line) - len(trimmed)
		if inPorts && spaces == 4 && len(trimmed) > 0 && trimmed[0] != '-' {
			inPorts = false
		}
		if inPorts && currentService != "" {
			if m := portRe.FindStringSubmatch(line); m != nil {
				result[currentService] = m[1]
			}
		}
	}
	return result
}

// PortOverride creates (or replaces) a docker-compose.override.yml that remaps
// a conflicting host port to a new one without modifying the original compose file.
func (h *ProjectHandlers) PortOverride(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	if proj.Type != "compose" {
		writeError(w, http.StatusBadRequest, errMsg("only compose projects support port override"))
		return
	}
	var body struct {
		OldPort string `json:"old_port"`
		NewPort string `json:"new_port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.OldPort == "" || body.NewPort == "" {
		writeError(w, http.StatusBadRequest, errMsg("old_port and new_port required"))
		return
	}
	composePath := findComposeFile(proj.Path)
	data, err := os.ReadFile(composePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("could not read compose file: %w", err))
		return
	}
	newContent, changed := replaceComposeHostPort(string(data), body.OldPort, body.NewPort)
	if !changed {
		writeError(w, http.StatusNotFound, fmt.Errorf("port %s not found in compose file", body.OldPort))
		return
	}
	// Back up the original compose file the first time it is modified.
	backupPath := composePath + ".original"
	if _, statErr := os.Stat(backupPath); os.IsNotExist(statErr) {
		_ = os.WriteFile(backupPath, data, 0644)
	}
	// Remove any stale additive override file left by an earlier run attempt.
	_ = os.Remove(filepath.Join(proj.Path, "docker-compose.override.yml"))
	if err := os.WriteFile(composePath, []byte(newContent), 0644); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("could not update compose file: %w", err))
		return
	}
	// Keep the DB ports field in sync so the frontend reflects the new mapping.
	if proj.Ports != "" {
		newPorts := strings.ReplaceAll(proj.Ports, body.OldPort+":", body.NewPort+":")
		h.db.UpdateProjectPorts(proj.ID, newPorts) //nolint:errcheck
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// replaceComposeHostPort replaces every host-port binding matching oldPort in the
// compose YAML. It handles quoted, unquoted, and IP-prefixed variants such as
// "8080:80", 8080:80, and 0.0.0.0:8080:80.
func replaceComposeHostPort(content, oldPort, newPort string) (string, bool) {
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(oldPort) + `:(\d+(?:/\w+)?)`)
	newContent := re.ReplaceAllString(content, newPort+":$1")
	return newContent, newContent != content
}

// InitRepo initialises a new git repository in the project directory and links it.
func (h *ProjectHandlers) InitRepo(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	if proj.RepoID != nil {
		writeError(w, http.StatusConflict, errMsg("project already has a linked repository"))
		return
	}
	if err := initProjectRepo(r.Context(), proj.Name, proj.Path); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("init repo: %w", err))
		return
	}
	// Try to create the repo record; if the path already exists, reuse it.
	repo, err := h.db.CreateGitRepo(storage.GitRepo{Name: proj.Name, Path: proj.Path})
	if err != nil {
		existing, lookupErr := h.db.GetGitRepoByPath(proj.Path)
		if lookupErr != nil || existing == nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		repo = existing
	}
	if err := h.db.LinkProjectRepo(proj.ID, repo.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, repo)
}

// ── Deploy-on-push (GitOps) ───────────────────────────────────────────────────

// installDeployHook writes a post-receive hook into the project's git repo so a
// push to the hosted repository triggers a build+run via the local webhook.
func installDeployHook(projectPath string, projectID int64, token string) error {
	hooksDir := filepath.Join(projectPath, ".git", "hooks")
	if err := os.MkdirAll(hooksDir, 0750); err != nil {
		return err
	}
	script := fmt.Sprintf("#!/bin/sh\n# Dockyard deploy-on-push\ncurl -fsS -X POST \"http://127.0.0.1:8080/webhooks/project/%d?token=%s\" >/dev/null 2>&1 || true\n", projectID, token)
	return os.WriteFile(filepath.Join(hooksDir, "post-receive"), []byte(script), 0755)
}

func removeDeployHook(projectPath string) {
	os.Remove(filepath.Join(projectPath, ".git", "hooks", "post-receive")) //nolint:errcheck
}

// GetDeployHook reports whether deploy-on-push is enabled for a project.
func (h *ProjectHandlers) GetDeployHook(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	enabled, token, _ := h.db.GetProjectDeploy(proj.ID)
	resp := map[string]any{"enabled": enabled}
	if enabled {
		resp["path"] = fmt.Sprintf("/webhooks/project/%d?token=%s", proj.ID, token)
	}
	writeJSON(w, resp)
}

// EnableDeployHook enables deploy-on-push and installs the post-receive hook.
func (h *ProjectHandlers) EnableDeployHook(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	if proj.RepoID == nil {
		writeError(w, http.StatusBadRequest, errMsg("project has no hosted repository — initialize one first"))
		return
	}
	token, err := h.db.EnableProjectDeploy(proj.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := installDeployHook(proj.Path, proj.ID, token); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("install hook: %w", err))
		return
	}
	h.db.LogEvent("deploy_on_push_enabled", actorName(r), "project", proj.Name, "", "", "deploy-on-push enabled") //nolint:errcheck
	writeJSON(w, map[string]any{"enabled": true, "path": fmt.Sprintf("/webhooks/project/%d?token=%s", proj.ID, token)})
}

// DisableDeployHook disables deploy-on-push and removes the hook.
func (h *ProjectHandlers) DisableDeployHook(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	_ = h.db.DisableProjectDeploy(proj.ID)
	removeDeployHook(proj.Path)
	writeJSON(w, map[string]any{"enabled": false})
}

// TriggerDeploy is a PUBLIC endpoint: a valid project deploy token (used by the
// post-receive hook) triggers an async build+run.
func (h *ProjectHandlers) TriggerDeploy(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid project id"))
		return
	}
	if !h.db.ValidateProjectDeploy(id, r.URL.Query().Get("token")) {
		writeError(w, http.StatusUnauthorized, errMsg("invalid deploy token"))
		return
	}
	proj, err := h.db.GetProject(id)
	if err != nil || proj == nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	go h.runBuildAndStart(context.Background(), proj)
	writeJSON(w, map[string]any{"message": "deploy triggered"})
}

// ── Async build logic ─────────────────────────────────────────────────────────

func (h *ProjectHandlers) runBuild(ctx context.Context, proj *storage.Project) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[panic] project %s build: %v", proj.Name, r)
			h.db.UpdateProjectStatus(proj.ID, "failed", fmt.Sprintf("build crashed: %v", r)) //nolint:errcheck
		}
	}()
	defer h.cleanupCancel(proj.ID)

	hub := newBroadcastHub()
	h.hubs.Store(proj.ID, hub)
	defer h.hubs.Delete(proj.ID)

	log.Printf("[project %s] build started", proj.Name)
	h.db.LogEvent("project_build_start", "user", "project", proj.Name, "", "", "") //nolint:errcheck

	var logBuf strings.Builder
	var buildErr error

	switch proj.Type {
	case "compose":
		composePath := findComposeFile(proj.Path)
		args := []string{"compose", "-f", composePath, "-p", composeProjectName(proj.Name), "build", "--no-cache"}
		buildErr = h.streamCommand(ctx, proj.ID, "build", proj.Path, &logBuf, hub, "docker", args...)
	case "dockerfile":
		buildErr = h.streamCommand(ctx, proj.ID, "build", proj.Path, &logBuf, hub,
			"docker", "build", "--no-cache", "-t", proj.ImageTag, proj.Path)
	}

	if buildErr != nil {
		finalStatus := "idle"
		if ctx.Err() == nil {
			finalStatus = "failed"
		}
		h.db.UpdateProjectStatus(proj.ID, finalStatus, "") //nolint:errcheck
		hub.finish(finalStatus, "")
		h.db.LogEvent("project_build_failed", "system", "project", proj.Name, "", "", buildErr.Error()) //nolint:errcheck
		log.Printf("[project %s] build failed: %v", proj.Name, buildErr)
		return
	}

	// Build succeeded — automatically start the containers.
	log.Printf("[project %s] build complete, starting containers", proj.Name)
	h.db.LogEvent("project_build_success", "system", "project", proj.Name, "", "", "") //nolint:errcheck
	h.db.UpdateProjectStatus(proj.ID, "running", "") //nolint:errcheck

	var runBuf strings.Builder
	var runErr error

	switch proj.Type {
	case "compose":
		composePath := findComposeFile(proj.Path)
		runErr = h.streamCommand(ctx, proj.ID, "run", proj.Path, &runBuf, nil,
			"docker", "compose", "-f", composePath, "-p", composeProjectName(proj.Name), "up", "-d")
	case "dockerfile":
		containerName := "project-" + strings.ToLower(proj.Name)
		exec.Command("docker", "rm", "-f", containerName).Run() //nolint:errcheck
		args := []string{"run", "-d", "--name", containerName}
		for _, p := range parsePorts(proj.Ports) {
			args = append(args, "-p", p)
		}
		args = append(args, proj.ImageTag)
		runErr = h.streamCommand(ctx, proj.ID, "run", proj.Path, &runBuf, nil, "docker", args...)
		if runErr == nil {
			h.db.UpdateProjectStatus(proj.ID, "running", containerName) //nolint:errcheck
		}
	}

	if runErr != nil {
		if ctx.Err() != nil {
			hub.finish("idle", "")
			return
		}
		portConflict := detectPortConflict(runBuf.String(), proj)
		h.db.UpdateProjectStatus(proj.ID, "failed", "") //nolint:errcheck
		hub.finish("failed", portConflict)
		h.db.LogEvent("project_run_failed", "system", "project", proj.Name, "", "", runErr.Error()) //nolint:errcheck
		log.Printf("[project %s] run failed: %v", proj.Name, runErr)
		return
	}

	hub.finish("running", "")
	h.db.LogEvent("project_start", "system", "project", proj.Name, "", "", "") //nolint:errcheck
	log.Printf("[project %s] running", proj.Name)
}

func (h *ProjectHandlers) runBuildAndStart(ctx context.Context, proj *storage.Project) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[panic] project %s build+run: %v", proj.Name, r)
			h.db.UpdateProjectStatus(proj.ID, "failed", fmt.Sprintf("build crashed: %v", r)) //nolint:errcheck
		}
	}()
	defer h.cleanupCancel(proj.ID)

	hub := newBroadcastHub()
	h.hubs.Store(proj.ID, hub)
	defer h.hubs.Delete(proj.ID)

	log.Printf("[project %s] build+run started", proj.Name)
	h.db.LogEvent("project_build_start", "user", "project", proj.Name, "", "", "") //nolint:errcheck

	var logBuf strings.Builder

	// 1. Build
	var buildErr error
	switch proj.Type {
	case "compose":
		composePath := findComposeFile(proj.Path)
		buildErr = h.streamCommand(ctx, proj.ID, "build", proj.Path, &logBuf, hub,
			"docker", "compose", "-f", composePath, "-p", composeProjectName(proj.Name), "build")
	case "dockerfile":
		buildErr = h.streamCommand(ctx, proj.ID, "build", proj.Path, &logBuf, hub,
			"docker", "build", "-t", proj.ImageTag, proj.Path)
	}

	if buildErr != nil {
		finalStatus := "idle"
		if ctx.Err() == nil {
			finalStatus = "failed"
		}
		h.db.UpdateProjectStatus(proj.ID, finalStatus, "") //nolint:errcheck
		hub.finish(finalStatus, "")
		h.db.LogEvent("project_build_failed", "system", "project", proj.Name, "", "", buildErr.Error()) //nolint:errcheck
		return
	}

	// 2. Start
	h.db.LogEvent("project_build_success", "system", "project", proj.Name, "", "", "") //nolint:errcheck
	h.db.UpdateProjectStatus(proj.ID, "running", "") //nolint:errcheck
	var runBuf strings.Builder
	var runErr error

	switch proj.Type {
	case "compose":
		composePath := findComposeFile(proj.Path)
		runErr = h.streamCommand(ctx, proj.ID, "run", proj.Path, &runBuf, nil,
			"docker", "compose", "-f", composePath, "-p", composeProjectName(proj.Name), "up", "-d")
	case "dockerfile":
		containerName := "project-" + strings.ToLower(proj.Name)
		// Remove any existing stopped container first.
		exec.Command("docker", "rm", "-f", containerName).Run() //nolint:errcheck
		args := []string{"run", "-d", "--name", containerName}
		for _, p := range parsePorts(proj.Ports) {
			args = append(args, "-p", p)
		}
		args = append(args, proj.ImageTag)
		runErr = h.streamCommand(ctx, proj.ID, "run", proj.Path, &runBuf, nil, "docker", args...)
		if runErr == nil {
			h.db.UpdateProjectStatus(proj.ID, "running", containerName) //nolint:errcheck
		}
	}

	if runErr != nil {
		if ctx.Err() != nil {
			hub.finish("idle", "")
			return
		}
		portConflict := detectPortConflict(runBuf.String(), proj)
		h.db.UpdateProjectStatus(proj.ID, "failed", "") //nolint:errcheck
		hub.finish("failed", portConflict)
		h.db.LogEvent("project_run_failed", "system", "project", proj.Name, "", "", runErr.Error()) //nolint:errcheck
		log.Printf("[project %s] run failed: %v", proj.Name, runErr)
		return
	}
	hub.finish("running", "")
	h.db.LogEvent("project_start", "system", "project", proj.Name, "", "", "") //nolint:errcheck
	log.Printf("[project %s] running", proj.Name)
}

// streamCommand runs a command, streams output to the DB log, and returns any error.
// logType is "build" or "run". hub may be nil (no fan-out).
func (h *ProjectHandlers) streamCommand(
	ctx context.Context,
	projID int64,
	logType string,
	dir string,
	buf *strings.Builder,
	hub *broadcastHub,
	name string,
	args ...string,
) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	// Use the classic builder (not BuildKit): the daemon is reached through a
	// docker-socket-proxy, which doesn't forward BuildKit's /session endpoint.
	// The classic builder's "Step X/Y" output is parsed by the frontend.
	cmd.Env = append(os.Environ(), "DOCKER_BUILDKIT=0")

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return err
	}

	lines := make(chan string, 256)
	var wg sync.WaitGroup
	for _, pipe := range []io.Reader{stdout, stderr} {
		wg.Add(1)
		go func(r io.Reader) {
			defer wg.Done()
			sc := bufio.NewScanner(r)
			for sc.Scan() {
				lines <- sc.Text()
			}
		}(pipe)
	}
	go func() { wg.Wait(); close(lines) }()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	flush := func() {
		snapshot := buf.String()
		if logType == "build" {
			h.db.UpdateProjectBuildLog(projID, snapshot) //nolint:errcheck
		} else {
			h.db.UpdateProjectRunLog(projID, snapshot) //nolint:errcheck
		}
	}

	for open := true; open; {
		select {
		case line, ok := <-lines:
			if !ok {
				open = false
				continue
			}
			buf.WriteString(line + "\n")
			if hub != nil {
				hub.publish(line)
			}
		case <-ticker.C:
			flush()
		}
	}
	flush()

	return cmd.Wait()
}

// StreamBuildLogs upgrades the HTTP connection to WebSocket and streams build-log lines
// for the given project in real time. Each message is a JSON object:
//
//	{"type":"line","data":"..."}   — one log line during an active build
//	{"type":"done","status":"..."}  — build finished (status: idle|failed|running)
//	{"type":"error","data":"..."}   — error before streaming started
//
// If no build is active, the stored build log is replayed line-by-line then "done" is sent.
func (h *ProjectHandlers) StreamBuildLogs(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// Drain client messages so the connection stays alive; cancel on close.
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	sendJSON := func(v any) error {
		b, _ := json.Marshal(v)
		return conn.WriteMessage(websocket.TextMessage, b)
	}

	hubVal, ok := h.hubs.Load(id)
	if !ok {
		// No active build — replay stored log from DB.
		proj, err := h.db.GetProject(id)
		if err != nil {
			sendJSON(map[string]string{"type": "error", "data": "project not found"}) //nolint:errcheck
			return
		}
		for _, line := range strings.Split(strings.TrimRight(proj.BuildLog, "\n"), "\n") {
			if line == "" {
				continue
			}
			if err := sendJSON(map[string]string{"type": "line", "data": line}); err != nil {
				return
			}
		}
		sendJSON(map[string]string{"type": "done", "status": proj.Status, "port_conflict": ""}) //nolint:errcheck
		return
	}

	hub := hubVal.(*broadcastHub)
	history, ch, done := hub.subscribe()

	// Send catch-up history.
	for _, line := range history {
		if err := sendJSON(map[string]string{"type": "line", "data": line}); err != nil {
			if ch != nil {
				hub.unsubscribe(ch)
			}
			return
		}
	}

	if done {
		sendJSON(map[string]string{"type": "done", "status": hub.doneStatus, "port_conflict": hub.donePortConflict}) //nolint:errcheck
		return
	}
	defer hub.unsubscribe(ch)

	// Stream live lines until the build finishes or the client disconnects.
	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-ch:
			if !ok {
				// Channel closed by hub.finish — build is done.
				sendJSON(map[string]string{"type": "done", "status": hub.doneStatus, "port_conflict": hub.donePortConflict}) //nolint:errcheck
				return
			}
			if err := sendJSON(map[string]string{"type": "line", "data": line}); err != nil {
				return
			}
		}
	}
}

// StreamDeleteProgress upgrades to a WebSocket and streams delete-progress
// frames for the given project (see delEvent). It replays buffered history so a
// client that connects mid-teardown still sees every prior step, then forwards
// live frames until the teardown finishes or the client disconnects.
func (h *ProjectHandlers) StreamDeleteProgress(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	sendJSON := func(v any) error {
		b, _ := json.Marshal(v)
		return conn.WriteMessage(websocket.TextMessage, b)
	}

	hubVal, ok := h.deleteHubs.Load(id)
	if !ok {
		sendJSON(delEvent{Type: "error", Data: "no active deletion"}) //nolint:errcheck
		return
	}
	hub := hubVal.(*deleteHub)
	history, ch, done := hub.subscribe()

	for _, ev := range history {
		if err := sendJSON(ev); err != nil {
			if ch != nil {
				hub.unsubscribe(ch)
			}
			return
		}
	}
	if done {
		return
	}
	defer hub.unsubscribe(ch)

	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return // channel closed by hub.finish — final frame was in history
			}
			if err := sendJSON(ev); err != nil {
				return
			}
		}
	}
}

func (h *ProjectHandlers) stopContainers(ctx context.Context, proj *storage.Project) {
	switch proj.Type {
	case "compose":
		composePath := findComposeFile(proj.Path)
		cmd := exec.CommandContext(ctx, "docker", "compose",
			"-f", composePath, "-p", composeProjectName(proj.Name), "stop")
		cmd.Run() //nolint:errcheck
	case "dockerfile":
		containerName := "project-" + strings.ToLower(proj.Name)
		exec.CommandContext(ctx, "docker", "stop", containerName).Run() //nolint:errcheck
	}
	h.db.UpdateProjectStatus(proj.ID, "stopped", "") //nolint:errcheck
}

func (h *ProjectHandlers) restartContainers(ctx context.Context, proj *storage.Project) error {
	switch proj.Type {
	case "compose":
		composePath := findComposeFile(proj.Path)
		return exec.CommandContext(ctx, "docker", "compose",
			"-f", composePath, "-p", composeProjectName(proj.Name), "restart").Run()
	case "dockerfile":
		containerName := "project-" + strings.ToLower(proj.Name)
		return exec.CommandContext(ctx, "docker", "restart", containerName).Run()
	}
	return nil
}

// Restart restarts running containers for the project without rebuilding.
func (h *ProjectHandlers) Restart(w http.ResponseWriter, r *http.Request) {
	proj, err := h.getProject(r)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("project not found"))
		return
	}
	if proj.Status != "running" {
		writeError(w, http.StatusConflict, errMsg("project is not running"))
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if err := h.restartContainers(ctx, proj); err != nil {
		writeError(w, http.StatusInternalServerError, errMsg("restart failed: "+err.Error()))
		return
	}
	writeJSON(w, map[string]string{"status": "running"})
}

func (h *ProjectHandlers) cleanupCancel(id int64) {
	h.mu.Lock()
	delete(h.cancels, id)
	h.mu.Unlock()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func (h *ProjectHandlers) getProject(r *http.Request) (*storage.Project, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		return nil, err
	}
	return h.db.GetProject(id)
}

// getProjectBranch returns the current git branch for a project directory.
// Returns an empty string if the directory is not a git repo or any error occurs.
func getProjectBranch(projPath string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", projPath, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// detectProjectType scans a directory for docker-compose.yml or Dockerfile.
func detectProjectType(dir string) string {
	composeNames := []string{"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"}
	for _, name := range composeNames {
		if fileExistsAt(filepath.Join(dir, name)) {
			return "compose"
		}
	}
	if fileExistsAt(filepath.Join(dir, "Dockerfile")) {
		return "dockerfile"
	}
	return "unknown"
}

func fileExistsAt(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// findComposeFile returns the path to the first docker-compose file found in dir.
func findComposeFile(dir string) string {
	for _, name := range []string{"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"} {
		p := filepath.Join(dir, name)
		if fileExistsAt(p) {
			return p
		}
	}
	return filepath.Join(dir, "docker-compose.yml")
}

func composeProjectName(name string) string {
	return "proj-" + strings.ToLower(name)
}

// zipSingleRoot returns the common root prefix shared by all entries in the zip,
// or an empty string if entries come from multiple roots.
func zipSingleRoot(zr *zip.Reader) string {
	var root string
	for _, f := range zr.File {
		parts := strings.SplitN(f.Name, "/", 2)
		if len(parts) < 2 {
			return ""
		}
		if root == "" {
			root = parts[0] + "/"
		} else if root != parts[0]+"/" {
			return ""
		}
	}
	return root
}

// extractZip extracts a zip archive to destDir, stripping the given prefix from paths.
func extractZip(zr *zip.Reader, destDir, stripPrefix string) error {
	for _, f := range zr.File {
		// Strip single-root prefix.
		relPath := strings.TrimPrefix(f.Name, stripPrefix)
		if relPath == "" || strings.HasPrefix(relPath, "..") {
			continue
		}

		// Zip-slip prevention.
		destPath := filepath.Join(destDir, filepath.FromSlash(relPath))
		if !strings.HasPrefix(destPath, filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("zip slip detected: %q", f.Name)
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(destPath, 0755); err != nil {
				return err
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return err
		}

		out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			out.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		rc.Close()
		out.Close()
		if copyErr != nil {
			return copyErr
		}
	}
	return nil
}

// buildFileTree recursively builds a FileNode tree up to maxDepth.
func buildFileTree(root, dir string, depth, maxDepth int) []FileNode {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	nodes := make([]FileNode, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") && name != ".env" {
			continue // hide hidden files except .env
		}
		if entry.IsDir() {
			if skipDirs[name] {
				continue
			}
			node := FileNode{Name: name, Type: "dir"}
			if depth < maxDepth-1 {
				node.Children = buildFileTree(root, filepath.Join(dir, name), depth+1, maxDepth)
			}
			nodes = append(nodes, node)
		} else {
			info, _ := entry.Info()
			size := int64(0)
			if info != nil {
				size = info.Size()
			}
			lines := 0
			if size > 0 && size < 512*1024 {
				if data, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
					lines = strings.Count(string(data), "\n")
					if len(data) > 0 && data[len(data)-1] != '\n' {
						lines++
					}
				}
			}
			nodes = append(nodes, FileNode{Name: name, Type: "file", Size: size, Lines: lines})
		}
	}
	return nodes
}

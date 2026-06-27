package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"docker-manager/backend/storage"

	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
)

// stackNameRe validates stack names to prevent path traversal and shell injection.
var stackNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

type StackHandlers struct {
	docker *client.Client
	db     *storage.DB
}

func NewStackHandlers(cli *client.Client, db *storage.DB) *StackHandlers {
	return &StackHandlers{docker: cli, db: db}
}

// --- path helpers ------------------------------------------------------------

func stacksBaseDir() string {
	if d := os.Getenv("STACKS_PATH"); d != "" {
		return filepath.Clean(d)
	}
	return "/data/stacks"
}

func stackComposeFile(name string) string {
	return filepath.Join(stacksBaseDir(), name, "docker-compose.yml")
}

func stackDir(name string) string {
	return filepath.Join(stacksBaseDir(), name)
}

// GetEnv returns a stack's stored environment variables (values decrypted).
func (h *StackHandlers) GetEnv(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, errMsg("invalid stack name"))
		return
	}
	vars, err := h.db.GetStackEnv(name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if vars == nil {
		vars = []storage.StackEnvVar{}
	}
	// Read-only viewers must not see secret values in cleartext. Operators and
	// admins (who may edit env, where SetEnv round-trips the values) still get
	// the real values so saving does not wipe secrets.
	if !canWrite(r) {
		for i := range vars {
			if vars[i].IsSecret {
				vars[i].Value = ""
			}
		}
	}
	writeJSON(w, vars)
}

// SetEnv replaces a stack's environment variables (encrypted at rest) and
// materializes a .env file next to its compose file so `docker compose` loads
// it on the next deploy/up.
func (h *StackHandlers) SetEnv(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, errMsg("invalid stack name"))
		return
	}
	var vars []storage.StackEnvVar
	if err := json.NewDecoder(r.Body).Decode(&vars); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	if err := h.db.SetStackEnv(name, vars); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.MkdirAll(stackDir(name), 0750); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	var b strings.Builder
	for _, v := range vars {
		if v.Key == "" {
			continue
		}
		b.WriteString(v.Key)
		b.WriteString("=")
		b.WriteString(v.Value)
		b.WriteString("\n")
	}
	if err := os.WriteFile(filepath.Join(stackDir(name), ".env"), []byte(b.String()), 0640); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"status": "saved", "count": len(vars)})
}

// --- types -------------------------------------------------------------------

type StackSummary struct {
	Name        string `json:"name"`
	Status      string `json:"status"` // running | partial | stopped
	Services    int    `json:"services"`
	Running     int    `json:"running"`
	HasFile     bool   `json:"has_file"`
	ConfigFiles string `json:"config_files,omitempty"` // basename of the primary compose file
	WorkDir     string `json:"work_dir,omitempty"`     // project working directory
}

type StackDetail struct {
	StackSummary
	Containers     []StackContainer `json:"containers"`
	ComposeContent string           `json:"compose_content,omitempty"`
}

type StackContainer struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Service string `json:"service"`
	Status  string `json:"status"`
	Image   string `json:"image"`
}

// --- compose subprocess -------------------------------------------------------

func runCompose(r *http.Request, args ...string) (string, error) {
	cmd := exec.CommandContext(r.Context(), "docker", append([]string{"compose"}, args...)...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

// --- privileged-compose policy -----------------------------------------------

// composeDangerPatterns flag compose directives that grant a container
// host-root-equivalent power. Because the backend mounts the Docker socket,
// allowing an operator to deploy these is a privilege escalation; deploying them
// is therefore restricted to admins (mirrors Portainer's admin-only stance).
// This is a defense-in-depth textual scan, not a full YAML parser.
var composeDangerPatterns = []struct {
	name string
	re   *regexp.Regexp
}{
	{"privileged mode", regexp.MustCompile(`(?im)^\s*-?\s*privileged\s*:\s*(?:true|yes|"true"|'true')\s*$`)},
	{"Docker socket mount", regexp.MustCompile(`(?i)/(?:var/)?run/docker\.sock`)},
	{"added capabilities (cap_add)", regexp.MustCompile(`(?im)^\s*cap_add\s*:`)},
	{"host PID namespace", regexp.MustCompile(`(?im)^\s*pid\s*:\s*["']?host["']?\s*$`)},
	{"host IPC namespace", regexp.MustCompile(`(?im)^\s*ipc\s*:\s*["']?host["']?\s*$`)},
	{"host user namespace", regexp.MustCompile(`(?im)^\s*userns_mode\s*:\s*["']?host["']?\s*$`)},
	{"unconfined security profile", regexp.MustCompile(`(?i)(?:seccomp|apparmor)\s*[:=]\s*["']?unconfined`)},
	{"host root bind mount", regexp.MustCompile(`(?im)(?:^\s*-\s*["']?/:|^\s*source\s*:\s*["']?/["']?\s*$)`)},
	{"host network mode", regexp.MustCompile(`(?im)^\s*network_mode\s*:\s*["']?host["']?\s*$`)},
	{"device passthrough (devices)", regexp.MustCompile(`(?im)^\s*devices\s*:\s*$`)},
}

// composePrivilegedDirective returns the name of the first host-root-equivalent
// directive found in the compose content, or "" if none.
func composePrivilegedDirective(content string) string {
	for _, p := range composeDangerPatterns {
		if p.re.MatchString(content) {
			return p.name
		}
	}
	return ""
}

// requireAdminForPrivilegedCompose answers the request with 403 and returns true
// when content uses a privileged directive and the caller is not an admin.
func requireAdminForPrivilegedCompose(w http.ResponseWriter, r *http.Request, content string) bool {
	if danger := composePrivilegedDirective(content); danger != "" && !isAdmin(r) {
		writeError(w, http.StatusForbidden,
			errMsg("compose uses a privileged feature ("+danger+") — only an admin may deploy it"))
		return true
	}
	return false
}

// --- handlers ----------------------------------------------------------------

// List returns all stacks: those inferred from running container labels plus
// any that have a stored compose file in STACKS_PATH.
func (h *StackHandlers) List(w http.ResponseWriter, r *http.Request) {
	containers, err := sharedContainers.list(r.Context(), h.docker, true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	stacks := map[string]*StackSummary{}

	for _, c := range containers {
		project := c.Labels["com.docker.compose.project"]
		if project == "" {
			continue
		}
		s, ok := stacks[project]
		if !ok {
			s = &StackSummary{Name: project}
			stacks[project] = s
		}
		s.Services++
		if c.State == "running" {
			s.Running++
		}
		// Populate compose metadata from the first container that has it.
		if s.ConfigFiles == "" {
			if cf := c.Labels["com.docker.compose.project.config_files"]; cf != "" {
				parts := strings.Split(cf, ",")
				s.ConfigFiles = filepath.Base(strings.TrimSpace(parts[0]))
			}
		}
		if s.WorkDir == "" {
			if wd := c.Labels["com.docker.compose.project.working_dir"]; wd != "" {
				s.WorkDir = wd
			}
		}
	}

	// Merge in stacks that have stored compose files but no live containers.
	entries, _ := os.ReadDir(stacksBaseDir())
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if _, err := os.Stat(filepath.Join(stacksBaseDir(), name, "docker-compose.yml")); err != nil {
			continue
		}
		if s, ok := stacks[name]; ok {
			s.HasFile = true
		} else {
			stacks[name] = &StackSummary{Name: name, HasFile: true}
		}
	}

	for _, s := range stacks {
		switch {
		case s.Services > 0 && s.Running == s.Services:
			s.Status = "running"
		case s.Running > 0:
			s.Status = "partial"
		default:
			s.Status = "stopped"
		}
	}

	result := make([]*StackSummary, 0, len(stacks))
	for _, s := range stacks {
		result = append(result, s)
	}
	writeJSON(w, result)
}

// Get returns detailed info for a single stack including its containers and
// compose file content (if stored).
func (h *StackHandlers) Get(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid stack name"))
		return
	}

	allContainers, err := sharedContainers.list(r.Context(), h.docker, true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	detail := &StackDetail{StackSummary: StackSummary{Name: name}}
	for _, c := range allContainers {
		if c.Labels["com.docker.compose.project"] != name {
			continue
		}
		detail.Services++
		if c.State == "running" {
			detail.Running++
		}
		cName := ""
		if len(c.Names) > 0 {
			cName = strings.TrimPrefix(c.Names[0], "/")
		}
		detail.Containers = append(detail.Containers, StackContainer{
			ID:      c.ID[:12],
			Name:    cName,
			Service: c.Labels["com.docker.compose.service"],
			Status:  c.Status,
			Image:   c.Image,
		})
	}

	switch {
	case detail.Services > 0 && detail.Running == detail.Services:
		detail.Status = "running"
	case detail.Running > 0:
		detail.Status = "partial"
	default:
		detail.Status = "stopped"
	}

	if content, err := os.ReadFile(stackComposeFile(name)); err == nil {
		detail.HasFile = true
		detail.ComposeContent = string(content)
	}

	writeJSON(w, detail)
}

// Deploy writes the supplied compose YAML to disk then runs
// `docker compose up -d --remove-orphans`.
func (h *StackHandlers) Deploy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !stackNameRe.MatchString(body.Name) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid stack name: use letters, digits, _ - . (max 64 chars)"))
		return
	}
	if strings.TrimSpace(body.Content) == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("compose content is required"))
		return
	}
	if requireAdminForPrivilegedCompose(w, r, body.Content) {
		return
	}

	if err := os.MkdirAll(stackDir(body.Name), 0750); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(stackComposeFile(body.Name), []byte(body.Content), 0640); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	out, err := runCompose(r, "-f", stackComposeFile(body.Name), "-p", body.Name, "up", "-d", "--remove-orphans")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("deploy failed: %w\n%s", err, out))
		return
	}
	_ = h.db.RecordStackDeploy(body.Name, body.Content)
	writeJSON(w, map[string]string{"message": "stack deployed", "output": out})
}

// History returns recent compose snapshots for a stack (newest first).
func (h *StackHandlers) History(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, errMsg("invalid stack name"))
		return
	}
	deploys, err := h.db.GetStackDeploys(name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if deploys == nil {
		deploys = []storage.StackDeploy{}
	}
	writeJSON(w, deploys)
}

// Rollback redeploys a previous compose snapshot of a stack.
func (h *StackHandlers) Rollback(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, errMsg("invalid stack name"))
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "deployId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid deploy id"))
		return
	}
	dep, err := h.db.GetStackDeploy(id)
	if err != nil || dep.StackName != name {
		writeError(w, http.StatusNotFound, errMsg("deploy not found"))
		return
	}
	if err := os.MkdirAll(stackDir(name), 0750); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(stackComposeFile(name), []byte(dep.Content), 0640); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	out, err := runCompose(r, "-f", stackComposeFile(name), "-p", name, "up", "-d", "--remove-orphans")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("rollback failed: %w\n%s", err, out))
		return
	}
	_ = h.db.RecordStackDeploy(name, dep.Content)
	writeJSON(w, map[string]string{"message": "rolled back", "output": out})
}

// GetWebhook returns (creating on first use) the stack's CI deploy webhook.
func (h *StackHandlers) GetWebhook(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, errMsg("invalid stack name"))
		return
	}
	token, err := h.db.EnsureStackWebhook(name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{
		"token": token,
		"path":  fmt.Sprintf("/webhooks/stack/%s?token=%s", name, token),
	})
}

// TriggerWebhook is a PUBLIC endpoint: called with the stack's webhook token it
// redeploys the stack's latest compose snapshot (for CI pipelines).
func (h *StackHandlers) TriggerWebhook(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, errMsg("invalid stack name"))
		return
	}
	if !h.db.ValidateStackWebhook(name, r.URL.Query().Get("token")) {
		writeError(w, http.StatusUnauthorized, errMsg("invalid webhook token"))
		return
	}
	deploys, err := h.db.GetStackDeploys(name)
	if err != nil || len(deploys) == 0 {
		writeError(w, http.StatusBadRequest, errMsg("no deploy snapshot to redeploy"))
		return
	}
	content := deploys[0].Content
	if err := os.MkdirAll(stackDir(name), 0750); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(stackComposeFile(name), []byte(content), 0640); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	out, err := runCompose(r, "-f", stackComposeFile(name), "-p", name, "up", "-d", "--remove-orphans")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("redeploy failed: %w\n%s", err, out))
		return
	}
	_ = h.db.RecordStackDeploy(name, content)
	writeJSON(w, map[string]string{"message": "redeployed", "output": out})
}

// Update replaces the stored compose file and re-deploys.
func (h *StackHandlers) Update(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid stack name"))
		return
	}

	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if strings.TrimSpace(body.Content) == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("compose content is required"))
		return
	}
	if requireAdminForPrivilegedCompose(w, r, body.Content) {
		return
	}

	if err := os.MkdirAll(stackDir(name), 0750); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(stackComposeFile(name), []byte(body.Content), 0640); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	out, err := runCompose(r, "-f", stackComposeFile(name), "-p", name, "up", "-d", "--remove-orphans")
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("update failed: %w\n%s", err, out))
		return
	}
	writeJSON(w, map[string]string{"message": "stack updated", "output": out})
}

// Action handles start / stop / restart / pull / up / down for a stack.
// "up" and "down" additionally support stacks without stored compose files
// by falling back to --project-name only.
func (h *StackHandlers) Action(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	action := chi.URLParam(r, "action")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid stack name"))
		return
	}

	cf := stackComposeFile(name)
	_, statErr := os.Stat(cf)
	hasFile := statErr == nil

	// Actions that require a stored compose file.
	if !hasFile {
		switch action {
		case "start", "stop", "pull", "up":
			writeError(w, http.StatusNotFound, fmt.Errorf("no compose file for stack %q — deploy it first", name))
			return
		}
	}

	var composeArgs []string
	switch action {
	case "start":
		composeArgs = []string{"-f", cf, "-p", name, "start"}
	case "stop":
		composeArgs = []string{"-f", cf, "-p", name, "stop"}
	case "restart":
		if hasFile {
			composeArgs = []string{"-f", cf, "-p", name, "restart"}
		} else {
			composeArgs = []string{"-p", name, "restart"}
		}
	case "pull":
		composeArgs = []string{"-f", cf, "-p", name, "pull"}
	case "up":
		composeArgs = []string{"-f", cf, "-p", name, "up", "-d", "--remove-orphans"}
	case "down":
		if hasFile {
			composeArgs = []string{"-f", cf, "-p", name, "down"}
		} else {
			composeArgs = []string{"-p", name, "down"}
		}
	default:
		writeError(w, http.StatusBadRequest, fmt.Errorf("unknown action %q", action))
		return
	}

	out, err := runCompose(r, composeArgs...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("action %q failed: %w\n%s", action, err, out))
		return
	}
	writeJSON(w, map[string]string{"message": action + " complete", "output": out})
}

// Remove runs `docker compose down` then deletes the stored compose directory.
func (h *StackHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid stack name"))
		return
	}

	cf := stackComposeFile(name)
	if _, err := os.Stat(cf); os.IsNotExist(err) {
		writeError(w, http.StatusNotFound, fmt.Errorf("no compose file for stack %q", name))
		return
	}

	args := []string{"-f", cf, "-p", name, "down"}
	if r.URL.Query().Get("volumes") == "true" {
		args = append(args, "--volumes")
	}

	out, err := runCompose(r, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("remove failed: %w\n%s", err, out))
		return
	}

	_ = os.RemoveAll(stackDir(name))
	writeJSON(w, map[string]string{"message": "stack removed", "output": out})
}

// Logs returns the combined stdout of `docker compose logs`.
func (h *StackHandlers) Logs(w http.ResponseWriter, r *http.Request) {
	// Log content is operator+ (may carry secrets). See canViewLogs.
	if !canViewLogs(r) {
		writeError(w, http.StatusForbidden, errMsg("operator role required"))
		return
	}
	name := chi.URLParam(r, "name")
	if !stackNameRe.MatchString(name) {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid stack name"))
		return
	}

	cf := stackComposeFile(name)
	if _, err := os.Stat(cf); os.IsNotExist(err) {
		writeError(w, http.StatusNotFound, fmt.Errorf("no compose file for stack %q", name))
		return
	}

	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "100"
	}

	out, err := runCompose(r, "-f", cf, "-p", name, "logs", "--no-color", "--tail", tail)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("logs failed: %w\n%s", err, out))
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, out) //nolint:errcheck
}

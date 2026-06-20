package handlers

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"docker-manager/backend/storage"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

// ─────────────────────────────────────────────────────────────────────────────
// Native self-update — lets Dockyard check whether a newer image of its own
// services has been published (digest comparison via the registry, no pull) and
// apply the update in place, so the operator never has to drop to the host /
// Portainer to run `docker compose pull && up -d` by hand.
//
// The hard constraint is that a container cannot stop+recreate ITSELF (its
// process dies mid-swap). So Apply launches a short-lived, detached *updater*
// container that runs compose against the same socket proxy; it outlives the
// backend's restart and finishes the job. This mirrors how Watchtower
// self-updates.
// ─────────────────────────────────────────────────────────────────────────────

// Build-stamped at link time via `-ldflags -X` (see backend/Dockerfile and the
// release workflow). Empty on local `--build` runs, in which case the UI just
// omits the commit.
var (
	appCommit    string
	appBuildDate string
)

const (
	lblComposeProject     = "com.docker.compose.project"
	lblComposeService     = "com.docker.compose.service"
	lblComposeWorkdir     = "com.docker.compose.project.working_dir"
	lblComposeConfigFiles = "com.docker.compose.project.config_files"
	// updaterName is reused across runs: the previous (exited) updater is removed
	// before a new one is created, so its logs survive for inspection until the
	// next update instead of vanishing on exit.
	updaterName = "dockyard-updater"
	// socketProxyHost is the in-network address of the docker-socket-proxy service
	// the updater talks to (the backend itself never touches the raw socket).
	socketProxyHost = "tcp://docker-socket-proxy:2375"
	updateCheckTTL  = 30 * time.Second
)

// UpdateComponent is the update state of one Dockyard service image.
type UpdateComponent struct {
	Service         string `json:"service"`          // compose service name (backend/frontend)
	Image           string `json:"image"`            // ghcr.io/owner/dockyard-backend:tag
	CurrentDigest   string `json:"current_digest"`   // digest the running container is on
	LatestDigest    string `json:"latest_digest"`    // digest the tag currently resolves to
	UpdateAvailable bool   `json:"update_available"` // current != latest (both known)
}

// UpdateStatus is the aggregate self-update report.
type UpdateStatus struct {
	CurrentVersion  string            `json:"current_version"`
	Commit          string            `json:"commit,omitempty"`
	BuildDate       string            `json:"build_date,omitempty"`
	Tag             string            `json:"tag"`           // the tag the stack tracks (latest / 0.0.x)
	Project         string            `json:"project"`       // compose project name
	ComposeReady    bool              `json:"compose_ready"` // DOCKYARD_COMPOSE_DIR set → Apply available
	Components      []UpdateComponent `json:"components"`
	UpdateAvailable bool              `json:"update_available"` // any component has an update
	CheckedAt       time.Time         `json:"checked_at"`
	Error           string            `json:"error,omitempty"` // non-fatal note (e.g. registry unreachable)
}

type UpdateHandlers struct {
	docker *client.Client
	db     *storage.DB
	bk     *BackupService

	mu       sync.Mutex
	cached   *UpdateStatus
	cachedAt time.Time
}

func NewUpdateHandlers(cli *client.Client, db *storage.DB, bk *BackupService) *UpdateHandlers {
	return &UpdateHandlers{docker: cli, db: db, bk: bk}
}

// composeDir returns the operator's explicit DOCKYARD_COMPOSE_DIR override (empty
// when unset).
func composeDir() string { return strings.TrimSpace(os.Getenv("DOCKYARD_COMPOSE_DIR")) }

// resolveCompose works out the host project directory and the exact compose
// file(s) the running stack was deployed with. It prefers the labels Compose
// stamps on every container (so self-update is zero-config and handles custom
// filenames like docker-compose.images.yml), and falls back to the
// DOCKYARD_COMPOSE_DIR override. dir is "" only when the instance wasn't deployed
// by Compose and no override is set — Apply is then unavailable.
func resolveCompose(labels map[string]string) (dir string, files []string) {
	// Explicit override wins: trust the operator's directory and let compose
	// auto-detect the file there (mixing an override dir with label file paths
	// from a different dir would be inconsistent).
	if d := composeDir(); d != "" {
		return d, nil
	}
	dir = labels[lblComposeWorkdir]
	if cf := labels[lblComposeConfigFiles]; cf != "" && dir != "" {
		for _, f := range strings.Split(cf, ",") {
			f = strings.TrimSpace(f)
			if f == "" {
				continue
			}
			if !filepath.IsAbs(f) {
				f = filepath.Join(dir, f)
			}
			files = append(files, f)
		}
	}
	return dir, files
}

// isDockyardImage limits the components we track to Dockyard's own images, so the
// third-party sidecars (socket proxy, registry) aren't surfaced as "updatable".
func isDockyardImage(ref string) bool { return strings.Contains(ref, "dockyard-") }

// refRepo strips the tag and digest from an image reference
// ("ghcr.io/o/dockyard-backend:latest" → "ghcr.io/o/dockyard-backend").
func refRepo(ref string) string {
	if i := strings.LastIndex(ref, "@"); i != -1 {
		ref = ref[:i]
	}
	if i := strings.LastIndex(ref, ":"); i != -1 && i > strings.LastIndex(ref, "/") {
		ref = ref[:i]
	}
	return ref
}

// refTag returns the tag portion of an image reference (default "latest").
func refTag(ref string) string {
	if i := strings.LastIndex(ref, "@"); i != -1 {
		ref = ref[:i]
	}
	if i := strings.LastIndex(ref, ":"); i != -1 && i > strings.LastIndex(ref, "/") {
		return ref[i+1:]
	}
	return "latest"
}

// localRepoDigest returns the manifest digest the running image was pulled at,
// from its RepoDigests. Empty for locally-built images (no registry digest).
func (h *UpdateHandlers) localRepoDigest(ctx context.Context, imageID, repo string) string {
	info, _, err := h.docker.ImageInspectWithRaw(ctx, imageID)
	if err != nil {
		return ""
	}
	for _, rd := range info.RepoDigests {
		i := strings.LastIndex(rd, "@")
		if i == -1 {
			continue
		}
		if repo == "" || strings.HasPrefix(rd, repo+"@") {
			return rd[i+1:]
		}
	}
	return ""
}

// remoteDigest resolves the digest a tag currently points to WITHOUT pulling the
// image, via the daemon's distribution endpoint (the socket proxy enables
// DISTRIBUTION). Returns "" on any failure (offline / private without auth) so a
// failed check degrades to "unknown" rather than erroring the whole report.
func (h *UpdateHandlers) remoteDigest(ctx context.Context, imageRef string) string {
	di, err := h.docker.DistributionInspect(ctx, imageRef, "")
	if err != nil {
		return ""
	}
	return di.Descriptor.Digest.String()
}

func (h *UpdateHandlers) componentFor(ctx context.Context, service, imageRef, imageID string) UpdateComponent {
	repo := refRepo(imageRef)
	local := h.localRepoDigest(ctx, imageID, repo)
	remote := h.remoteDigest(ctx, imageRef)
	return UpdateComponent{
		Service:         service,
		Image:           imageRef,
		CurrentDigest:   local,
		LatestDigest:    remote,
		UpdateAvailable: local != "" && remote != "" && local != remote,
	}
}

// gatherStatus inspects the running stack and compares each Dockyard image's
// running digest against the registry to determine update availability.
func (h *UpdateHandlers) gatherStatus(ctx context.Context) (*UpdateStatus, error) {
	st := &UpdateStatus{
		CurrentVersion: appVersion,
		Commit:         appCommit,
		BuildDate:      appBuildDate,
		CheckedAt:      time.Now().UTC(),
		Components:     []UpdateComponent{},
	}

	hn, err := os.Hostname()
	if err != nil {
		return nil, fmt.Errorf("resolve hostname: %w", err)
	}
	self, err := h.docker.ContainerInspect(ctx, hn)
	if err != nil {
		return nil, fmt.Errorf("inspect own container: %w", err)
	}
	project := ""
	selfImage := ""
	var selfLabels map[string]string
	if self.Config != nil {
		selfLabels = self.Config.Labels
		project = selfLabels[lblComposeProject]
		selfImage = self.Config.Image
	}
	st.Project = project
	st.Tag = refTag(selfImage)
	if dir, _ := resolveCompose(selfLabels); dir != "" {
		st.ComposeReady = true
	}

	if project == "" {
		// Not a compose deployment (e.g. a bare `docker run` / dev build): we can
		// still report the backend's own image, but Apply won't be offered.
		st.Components = append(st.Components, h.componentFor(ctx, "backend", selfImage, self.Image))
	} else {
		list, err := h.docker.ContainerList(ctx, container.ListOptions{All: true})
		if err != nil {
			return nil, fmt.Errorf("list containers: %w", err)
		}
		seen := map[string]bool{}
		for _, c := range list {
			if c.Labels[lblComposeProject] != project || !isDockyardImage(c.Image) {
				continue
			}
			svc := c.Labels[lblComposeService]
			if svc == "" {
				svc = strings.TrimPrefix(firstName(c.Names), "/")
			}
			if seen[svc] {
				continue
			}
			seen[svc] = true
			st.Components = append(st.Components, h.componentFor(ctx, svc, c.Image, c.ImageID))
		}
	}

	for _, comp := range st.Components {
		if comp.UpdateAvailable {
			st.UpdateAvailable = true
		}
		if comp.LatestDigest == "" {
			st.Error = "Could not reach the registry to check one or more images."
		}
	}
	return st, nil
}

func firstName(names []string) string {
	if len(names) > 0 {
		return names[0]
	}
	return ""
}

// Check reports current vs. latest image digests. Result is cached briefly so the
// page and a possible nav badge can both poll cheaply without hammering the
// registry. Admin-only.
func (h *UpdateHandlers) Check(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	force := r.URL.Query().Get("force") == "true"

	h.mu.Lock()
	if !force && h.cached != nil && time.Since(h.cachedAt) < updateCheckTTL {
		st := h.cached
		h.mu.Unlock()
		writeJSON(w, st)
		return
	}
	h.mu.Unlock()

	st, err := h.gatherStatus(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	h.mu.Lock()
	h.cached, h.cachedAt = st, time.Now()
	h.mu.Unlock()
	writeJSON(w, st)
}

// Logs returns the recent output and exit state of the most recent updater
// container, so a failed/stuck self-update isn't a black box. Admin-only.
func (h *UpdateHandlers) Logs(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	ctx := r.Context()
	rc, err := h.docker.ContainerLogs(ctx, updaterName, container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: "400",
	})
	if err != nil {
		// No updater container (never run, or already removed) — not an error.
		writeJSON(w, map[string]any{"exists": false, "logs": ""})
		return
	}
	defer rc.Close()

	// Container logs are multiplexed (no TTY) — demux stdout+stderr into one buffer.
	var buf bytes.Buffer
	if _, derr := stdcopy.StdCopy(&buf, &buf, rc); derr != nil {
		log.Printf("[update] read updater logs: %v", derr)
	}

	state := ""
	if insp, ierr := h.docker.ContainerInspect(ctx, updaterName); ierr == nil && insp.State != nil {
		state = insp.State.Status
		if insp.State.Status == "exited" {
			state = fmt.Sprintf("exited (code %d)", insp.State.ExitCode)
		}
	}
	writeJSON(w, map[string]any{"exists": true, "state": state, "logs": buf.String()})
}

// Apply pulls the new images and recreates the stack in place by launching a
// detached updater container that runs `docker compose pull && up -d`. The
// backend is one of the services that gets recreated, so this handler returns
// BEFORE the swap completes; clients should poll until the API comes back.
// Admin + write tier.
func (h *UpdateHandlers) Apply(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	if !canWrite(r) {
		writeError(w, http.StatusForbidden, errMsg("write access required"))
		return
	}

	// The updater runs compose, so it must operate on the real deployment: we need
	// the project name, the exact compose file(s) and host directory, an image
	// that ships the compose CLI (the backend's own does — reuse it), and the
	// network that can reach the socket proxy. All come from our own container.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	hn, err := os.Hostname()
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("resolve hostname: %w", err))
		return
	}
	self, err := h.docker.ContainerInspect(ctx, hn)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("inspect own container: %w", err))
		return
	}
	if self.Config == nil || self.Config.Labels[lblComposeProject] == "" {
		writeError(w, http.StatusPreconditionFailed, errMsg("this instance is not running under docker compose; update manually"))
		return
	}
	project := self.Config.Labels[lblComposeProject]
	updaterImage := self.Config.Image

	dir, files := resolveCompose(self.Config.Labels)
	if dir == "" {
		writeError(w, http.StatusPreconditionFailed,
			errMsg("could not determine the compose project directory; set DOCKYARD_COMPOSE_DIR to its host path and restart, or update manually with `docker compose pull && docker compose up -d`"))
		return
	}
	if !filepath.IsAbs(dir) {
		writeError(w, http.StatusPreconditionFailed, errMsg("the compose project directory must be an absolute host path; set DOCKYARD_COMPOSE_DIR"))
		return
	}

	netName := ""
	if self.NetworkSettings != nil {
		for n := range self.NetworkSettings.Networks {
			netName = n
			break
		}
	}

	// Best-effort consistent snapshot before mutating the running stack, so a bad
	// release can be rolled back. Never blocks the update if backups aren't set up.
	if h.bk != nil && h.bk.AppBackupConfigured() {
		if info, berr := h.bk.BackupApp(0); berr != nil {
			log.Printf("[update] pre-update backup failed (continuing): %v", berr)
		} else {
			log.Printf("[update] pre-update backup written: %s", info.Name)
		}
	}

	// Bind the project dir at the SAME absolute path inside the updater so
	// compose's relative bind sources (./backups, build contexts) resolve to the
	// real host paths, and the working-dir basename matches the original project.
	// `-p` pins the project name and `-f` pins the exact compose file(s) the stack
	// was deployed with (handles non-default filenames / overlays); both come from
	// Compose's own labels. `sleep` lets this HTTP response flush before the
	// backend is torn down.
	fflags := ""
	for _, f := range files {
		fflags += fmt.Sprintf(" -f %q", f)
	}
	// Robustness: --ignore-pull-failures so a transient Docker Hub hiccup on a
	// sidecar image (registry / socket-proxy, already present locally anyway)
	// doesn't abort the whole update before `up -d` runs; the echo markers make
	// the updater container's logs readable (surfaced on the Updates page).
	script := fmt.Sprintf(
		"echo '[dockyard-updater] starting'\n"+
			"sleep 2\n"+
			"cd %q || { echo '[dockyard-updater] ERROR: cannot cd to project dir'; exit 1; }\n"+
			"echo '[dockyard-updater] pulling new images'\n"+
			"docker compose -p %q%s pull --ignore-pull-failures || echo '[dockyard-updater] WARN: some image pulls failed, continuing'\n"+
			"echo '[dockyard-updater] recreating stack'\n"+
			"docker compose -p %q%s up -d\n"+
			"echo \"[dockyard-updater] finished with exit code $?\"\n",
		dir, project, fflags, project, fflags,
	)

	cfg := &container.Config{
		Image:      updaterImage,
		Entrypoint: []string{"/bin/sh", "-c"},
		Cmd:        []string{script},
		Env:        []string{"DOCKER_HOST=" + socketProxyHost},
		User:       "0",
		Labels:     map[string]string{"dockyard.role": "updater"},
	}
	hostCfg := &container.HostConfig{
		Binds:         []string{dir + ":" + dir},
		AutoRemove:    false,
		RestartPolicy: container.RestartPolicy{Name: "no"},
	}
	if netName != "" {
		hostCfg.NetworkMode = container.NetworkMode(netName)
	}

	// Remove a prior (exited) updater so the name is free and old logs are cleared.
	_ = h.docker.ContainerRemove(ctx, updaterName, container.RemoveOptions{Force: true})

	created, err := h.docker.ContainerCreate(ctx, cfg, hostCfg, nil, nil, updaterName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("create updater: %w", err))
		return
	}
	if err := h.docker.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("start updater: %w", err))
		return
	}

	h.db.LogEvent("dockyard_update_started", actorName(r), "system", "dockyard", "", project, //nolint:errcheck
		"Self-update started: pulling new images and recreating the stack")
	// Invalidate the cached check so the post-update page reflects reality.
	h.mu.Lock()
	h.cached = nil
	h.mu.Unlock()

	writeJSON(w, map[string]any{"status": "updating", "updater": created.ID})
}

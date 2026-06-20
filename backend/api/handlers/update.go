package handlers

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
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
// Portainer to update it by hand.
//
// The hard constraint is that a container cannot stop+recreate ITSELF (its
// process dies mid-swap). So Apply launches a short-lived, detached *updater*
// container (the Dockyard image running the `self-update` subcommand) that pulls
// each image and recreates the containers from their existing config; it outlives
// the backend's restart and finishes the job. This is deployment-agnostic — no
// compose file is needed — so it works under plain compose, Portainer, or
// docker run. (Mirrors how Watchtower self-updates.)
// ─────────────────────────────────────────────────────────────────────────────

// Build-stamped at link time via `-ldflags -X` (see backend/Dockerfile and the
// release workflow). Empty on local `--build` runs, in which case the UI just
// omits the commit.
var (
	appCommit    string
	appBuildDate string
)

const (
	lblComposeProject = "com.docker.compose.project"
	lblComposeService = "com.docker.compose.service"
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
	Tag             string            `json:"tag"`         // the tag the stack tracks (latest / 0.0.x)
	Project         string            `json:"project"`     // compose project name
	ApplyReady      bool              `json:"apply_ready"` // in-app update can be applied (running as a recreatable container)
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
	if self.Config != nil {
		project = self.Config.Labels[lblComposeProject]
		selfImage = self.Config.Image
	}
	st.Project = project
	st.Tag = refTag(selfImage)

	if project == "" {
		// Not a compose deployment (e.g. a bare `docker run` / dev build): we can
		// still report and recreate the backend's own image.
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
	// We can apply an update in place as long as we found Dockyard service
	// containers to recreate (i.e. we're running as a managed container).
	st.ApplyReady = len(st.Components) > 0
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

// Apply recreates the stack in place by launching a detached updater container
// (the Dockyard image running the `self-update` subcommand) that pulls each image
// and recreates the containers from their existing config. The backend is one of
// the services recreated, so this handler returns BEFORE the swap completes;
// clients should poll until the API comes back. Admin + write tier.
func (h *UpdateHandlers) Apply(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	if !canWrite(r) {
		writeError(w, http.StatusForbidden, errMsg("write access required"))
		return
	}

	// The updater is the backend's own image (so it has the self-update routine);
	// it needs the network that can reach the socket proxy and the compose project
	// name to scope which containers to recreate. All come from our own container.
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
	if self.Config == nil {
		writeError(w, http.StatusPreconditionFailed, errMsg("cannot read own container config; update manually"))
		return
	}
	project := self.Config.Labels[lblComposeProject]
	updaterImage := self.Config.Image
	netName := ""
	if self.NetworkSettings != nil {
		for n := range self.NetworkSettings.Networks {
			netName = n
			break
		}
	}
	if netName == "" {
		writeError(w, http.StatusPreconditionFailed, errMsg("could not determine a network to reach the Docker socket proxy; update manually"))
		return
	}

	// Best-effort consistent snapshot before mutating the running stack, so a bad
	// release can be rolled back. Never blocks the update if backups aren't set up.
	backupName := ""
	if h.bk != nil && h.bk.AppBackupConfigured() {
		if info, berr := h.bk.BackupApp(0); berr != nil {
			log.Printf("[update] pre-update backup failed (continuing): %v", berr)
		} else {
			backupName = info.Name
			log.Printf("[update] pre-update backup written: %s", info.Name)
		}
	}

	// The updater runs `docker-manager self-update <project>` via the image's
	// entrypoint (which drops to the app user, then execs the binary with these
	// args). It talks to the daemon through the socket proxy on the shared network.
	cfg := &container.Config{
		Image:  updaterImage,
		Cmd:    []string{"self-update", project},
		Env:    []string{"DOCKER_HOST=" + socketProxyHost},
		Labels: map[string]string{"dockyard.role": "updater"},
	}
	hostCfg := &container.HostConfig{
		NetworkMode:   container.NetworkMode(netName),
		AutoRemove:    false,
		RestartPolicy: container.RestartPolicy{Name: "no"},
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

	writeJSON(w, map[string]any{"status": "updating", "updater": created.ID, "backup": backupName})
}

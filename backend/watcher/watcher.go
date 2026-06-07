package watcher

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"docker-manager/backend/storage"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
)

// Watcher polls container images for new versions and optionally auto-updates them.
type Watcher struct {
	db     *storage.DB
	docker *client.Client

	mu       sync.Mutex
	reload   chan struct{}
	checkNow chan struct{}
	// failed tracks containers whose last update check failed, so a
	// persistently-unreachable registry logs a single check_failed event per
	// failure episode instead of one every cycle.
	failed map[string]bool
}

// New creates a new Watcher.
func New(db *storage.DB, cli *client.Client) *Watcher {
	return &Watcher{
		db:       db,
		docker:   cli,
		reload:   make(chan struct{}, 1),
		checkNow: make(chan struct{}, 1),
		failed:   make(map[string]bool),
	}
}

// Reload signals the watcher to re-read the database configuration.
func (w *Watcher) Reload() {
	select {
	case w.reload <- struct{}{}:
	default:
	}
}

// CheckNow triggers an immediate check cycle.
func (w *Watcher) CheckNow() {
	select {
	case w.checkNow <- struct{}{}:
	default:
	}
}

// Run starts the watcher loop; it blocks until ctx is cancelled.
func (w *Watcher) Run(ctx context.Context) {
	log.Println("[watcher] started")
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("[watcher] stopped")
			return
		case <-ticker.C:
			w.runCycle(ctx, false)
		case <-w.checkNow:
			w.runCycle(ctx, true)
		case <-w.reload:
			log.Println("[watcher] config reloaded")
		}
	}
}

// runCycle checks watched images. The 60s ticker only sets the resolution; when
// force is false each image is checked at most once per its own check_interval
// (default 5 min) so we don't hammer the registry (Docker Hub rate-limits
// anonymous pulls and returns 429). A manual "check now" passes force=true.
func (w *Watcher) runCycle(ctx context.Context, force bool) {
	items, err := w.db.GetWatchedImages()
	if err != nil {
		log.Printf("[watcher] db error: %v", err)
		return
	}

	now := time.Now().UTC()
	for _, item := range items {
		if !item.Enabled {
			continue
		}
		if !force && item.LastCheckedAt != nil {
			interval := time.Duration(item.CheckInterval) * time.Second
			if interval < 60*time.Second {
				interval = 300 * time.Second
			}
			if now.Sub(item.LastCheckedAt.UTC()) < interval {
				continue
			}
		}
		w.checkItem(ctx, item)
	}
}

// CheckContainer runs an immediate update check for a single watched container.
func (w *Watcher) CheckContainer(ctx context.Context, containerID string) error {
	item, err := w.db.GetWatchedImage(containerID)
	if err != nil {
		return err
	}
	if item == nil {
		return fmt.Errorf("container is not watched")
	}
	w.checkItem(ctx, *item)
	return nil
}

// UpdateContainer pulls the latest image and recreates a single watched
// container immediately (the manual "Update now" action).
func (w *Watcher) UpdateContainer(ctx context.Context, containerID string) error {
	item, err := w.db.GetWatchedImage(containerID)
	if err != nil {
		return err
	}
	if item == nil {
		return fmt.Errorf("container is not watched")
	}
	remoteDigest, err := fetchRemoteDigest(item.Image)
	if err != nil {
		return fmt.Errorf("fetch remote digest: %w", err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.performUpdate(ctx, *item, remoteDigest); err != nil {
		w.db.LogEvent("update_failed", "user", "image", item.Image, item.ContainerID, item.Image, err.Error()) //nolint:errcheck
		return err
	}
	w.db.LogEvent("update_success", "user", "image", item.Image, "", item.Image, //nolint:errcheck
		fmt.Sprintf("Container updated to %s", shortDigest(remoteDigest)))
	return nil
}

// localImageDigest returns the manifest digest (sha256:…) of the image the
// container is currently running, taken from its RepoDigests. Empty when the
// image was built locally / never pulled, in which case updates can't be checked.
func (w *Watcher) localImageDigest(ctx context.Context, imageRef string) string {
	info, _, err := w.docker.ImageInspectWithRaw(ctx, imageRef)
	if err != nil {
		return ""
	}
	for _, rd := range info.RepoDigests {
		if i := strings.LastIndex(rd, "@"); i != -1 {
			return rd[i+1:]
		}
	}
	return ""
}

func (w *Watcher) checkItem(ctx context.Context, item storage.WatchedImage) {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Baseline = the digest the container is actually running; compare against the
	// registry's current digest for the same tag.
	localDigest := w.localImageDigest(ctx, item.Image)
	if localDigest == "" {
		// Locally-built or never-pulled image: there's no registry digest to
		// compare against, so an update check is meaningless. Record the attempt
		// and skip quietly (no fetch, no check_failed noise).
		w.db.TouchWatchedImageChecked(item.ContainerID) //nolint:errcheck
		return
	}

	remoteDigest, err := fetchRemoteDigest(item.Image)
	if err != nil {
		w.db.TouchWatchedImageChecked(item.ContainerID) //nolint:errcheck
		log.Printf("[watcher] digest fetch failed for %s: %v", item.Image, err)
		// Log a check_failed event only when the check *newly* starts failing, so a
		// persistently-unreachable or rate-limiting registry doesn't flood the
		// event log every cycle. Cleared again on the next successful check.
		if !w.failed[item.ContainerID] {
			w.failed[item.ContainerID] = true
			w.db.LogEvent("check_failed", "system", "image", item.Image, "", item.Image, //nolint:errcheck
				fmt.Sprintf("Failed to fetch remote digest: %v", err))
		}
		return
	}
	delete(w.failed, item.ContainerID) // check succeeded — reset failure state

	updateAvailable := remoteDigest != "" && localDigest != remoteDigest
	w.db.UpdateWatchedImageState(item.ContainerID, localDigest, updateAvailable) //nolint:errcheck

	if !updateAvailable {
		log.Printf("[watcher] %s is up to date (%s)", item.Image, shortDigest(localDigest))
		return
	}

	// Log only when the update *newly* becomes available, not every cycle.
	if !item.UpdateAvailable {
		log.Printf("[watcher] new version available for %s: %s -> %s",
			item.Image, shortDigest(localDigest), shortDigest(remoteDigest))
		w.db.LogEvent("update_available", "system", "image", item.Image, "", item.Image, //nolint:errcheck
			fmt.Sprintf("New version available: %s → %s", shortDigest(localDigest), shortDigest(remoteDigest)))
	}

	if !item.AutoUpdate {
		return
	}

	if err := w.performUpdate(ctx, item, remoteDigest); err != nil {
		log.Printf("[watcher] auto-update failed for %s: %v", item.ContainerID, err)
		w.db.LogEvent("update_failed", "system", "image", item.Image, item.ContainerID, item.Image, //nolint:errcheck
			fmt.Sprintf("Auto-update failed: %v", err))
		return
	}

	w.db.LogEvent("update_success", "system", "image", item.Image, "", item.Image, //nolint:errcheck
		fmt.Sprintf("Container updated to %s", shortDigest(remoteDigest)))
	log.Printf("[watcher] successfully updated %s (%s)", item.ContainerName, item.Image)
}

// performUpdate pulls the new image, stops the container, recreates it with the same
// configuration, and starts it again.
func (w *Watcher) performUpdate(ctx context.Context, item storage.WatchedImage, newDigest string) error {
	// 1. Pull the new image.
	rc, err := w.docker.ImagePull(ctx, item.Image, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("image pull: %w", err)
	}
	io.Copy(io.Discard, rc) //nolint:errcheck
	rc.Close()

	// 2. Inspect existing container to capture its configuration.
	info, err := w.docker.ContainerInspect(ctx, item.ContainerID)
	if err != nil {
		return fmt.Errorf("inspect: %w", err)
	}

	// 3. Stop the existing container.
	timeout := 30
	if err := w.docker.ContainerStop(ctx, item.ContainerID, container.StopOptions{Timeout: &timeout}); err != nil {
		return fmt.Errorf("stop: %w", err)
	}

	// 4. Remove the existing container (keep volumes).
	if err := w.docker.ContainerRemove(ctx, item.ContainerID, container.RemoveOptions{}); err != nil {
		return fmt.Errorf("remove old: %w", err)
	}

	// 5. Recreate container with the same config.
	newID, err := w.docker.ContainerCreate(
		ctx,
		info.Config,
		info.HostConfig,
		nil,
		nil,
		info.Name,
	)
	if err != nil {
		return fmt.Errorf("create: %w", err)
	}

	// 6. Start the new container.
	if err := w.docker.ContainerStart(ctx, newID.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	// 7. Re-key the watched_images row onto the new container ID and reset its
	//    state — it now runs the latest digest, so no update is available.
	w.db.DeleteWatchedImage(item.ContainerID) //nolint:errcheck
	item.ContainerID = newID.ID
	item.CurrentDigest = newDigest
	w.db.UpsertWatchedImage(item)                           //nolint:errcheck
	w.db.UpdateWatchedImageState(newID.ID, newDigest, false) //nolint:errcheck

	return nil
}

// ---- Registry helpers -------------------------------------------------------

type tokenResponse struct {
	Token string `json:"token"`
}

type manifestResponse struct {
	Config struct {
		Digest string `json:"digest"`
	} `json:"config"`
}

// hubClient bounds every Docker Hub call so a slow or unreachable network (e.g.
// an air-gapped/offline host) fails fast instead of stalling the watcher loop.
var hubClient = &http.Client{Timeout: 10 * time.Second}

// fetchRemoteDigest queries the Docker Hub (or a compatible registry) for the
// content-addressable digest of the specified image tag.
func fetchRemoteDigest(imageRef string) (string, error) {
	repo, tag := parseImageRef(imageRef)

	// For Docker Hub images, obtain an anonymous auth token first.
	token, err := fetchHubToken(repo)
	if err != nil {
		return "", fmt.Errorf("auth token: %w", err)
	}

	// Fetch the manifest to get the config digest.
	url := fmt.Sprintf("https://registry-1.docker.io/v2/%s/manifests/%s", repo, tag)
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	// Accept manifest lists / OCI indexes first so the registry returns the same
	// top-level digest a `docker pull <tag>` resolves to (what RepoDigests stores),
	// keeping the comparison correct for multi-arch images.
	req.Header.Set("Accept", strings.Join([]string{
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	}, ", "))

	resp, err := hubClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry returned %d", resp.StatusCode)
	}

	digest := resp.Header.Get("Docker-Content-Digest")
	if digest == "" {
		var m manifestResponse
		if err := json.NewDecoder(resp.Body).Decode(&m); err == nil {
			digest = m.Config.Digest
		}
	}
	return digest, nil
}

func fetchHubToken(repo string) (string, error) {
	// Official images have implicit "library/" prefix.
	scope := fmt.Sprintf("repository:%s:pull", repo)
	url := fmt.Sprintf("https://auth.docker.io/token?service=registry.docker.io&scope=%s", scope)

	resp, err := hubClient.Get(url) //nolint:noctx
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var t tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
		return "", err
	}
	return t.Token, nil
}

// parseImageRef splits "nginx:latest" into ("library/nginx", "latest").
// Handles official images, user images, and fully-qualified references.
func parseImageRef(ref string) (repo, tag string) {
	tag = "latest"
	// Strip any registry prefix (e.g., docker.io/) — we always hit Docker Hub.
	if strings.HasPrefix(ref, "docker.io/") {
		ref = strings.TrimPrefix(ref, "docker.io/")
	}

	if idx := strings.LastIndex(ref, ":"); idx != -1 {
		tag = ref[idx+1:]
		ref = ref[:idx]
	}

	// Official images need the "library/" prefix for the registry v2 API.
	if !strings.Contains(ref, "/") {
		ref = "library/" + ref
	}
	return ref, tag
}

func shortDigest(d string) string {
	if len(d) > 19 {
		return d[:19]
	}
	return d
}

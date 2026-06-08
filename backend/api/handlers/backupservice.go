package handlers

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"docker-manager/backend/storage"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
)

// ─────────────────────────────────────────────────────────────────────────────
// BackupService — the volume backup/restore engine and the opt-in scheduler.
//
// It mirrors the image watcher's design: a single instance created in main(),
// looped in the background on a ticker, and shared with the HTTP handlers (which
// are thin wrappers around it). The heavy tar/extract work runs in throw-away
// helper containers that mount the volumes directly — never through the backend.
// ─────────────────────────────────────────────────────────────────────────────

const (
	vbBackupMount     = "/backups"
	vbBackupLabel     = "docker-manager.volume-backup"
	vbBackupKeepDef   = 10
	vbBackupOpTimeout = 30 * time.Minute
	vbScheduleTick    = 5 * time.Minute // resolution; each schedule fires at most per its own interval
)

type BackupService struct {
	docker       *client.Client
	db           *storage.DB
	backupVolume string // named volume backing /backups ("" → backups disabled)
	image        string

	mu         sync.Mutex
	imageReady bool
}

// NewBackupService wires the engine and discovers where backups are stored.
func NewBackupService(cli *client.Client, db *storage.DB) *BackupService {
	img := strings.TrimSpace(os.Getenv("VOLUME_BROWSER_IMAGE"))
	if img == "" {
		img = "busybox:latest"
	}
	bv := strings.TrimSpace(os.Getenv("BACKUP_VOLUME"))
	if bv == "" {
		bv = discoverBackupVolume(cli)
	}
	s := &BackupService{docker: cli, db: db, backupVolume: bv, image: img}
	go s.sweepStaleHelpers(context.Background()) // clean helpers left by a prior crash
	return s
}

// Configured reports whether a backup store is available.
func (s *BackupService) Configured() bool { return s.backupVolume != "" }

// discoverBackupVolume inspects this container for the volume mounted at /backups
// and returns its Docker name ("" if not mounted / not discoverable).
func discoverBackupVolume(cli *client.Client) string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	info, err := cli.ContainerInspect(ctx, host)
	if err != nil {
		return ""
	}
	for _, m := range info.Mounts {
		if m.Destination == vbBackupMount && m.Type == "volume" && m.Name != "" {
			return m.Name
		}
	}
	return ""
}

func vbBackupKeep() int {
	if v := strings.TrimSpace(os.Getenv("BACKUP_KEEP")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return vbBackupKeepDef
}

// backupScheduleTick is the polling resolution for due schedules. Override with
// $BACKUP_SCHEDULE_TICK_SECONDS (min 5s) for tighter/looser cadence; a schedule
// still fires at most once per its own interval.
func backupScheduleTick() time.Duration {
	if v := strings.TrimSpace(os.Getenv("BACKUP_SCHEDULE_TICK_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 5 {
			return time.Duration(n) * time.Second
		}
	}
	return vbScheduleTick
}

// sanitizeVol reduces a volume name to filesystem-safe characters (defence in depth).
func sanitizeVol(s string) string {
	out := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		default:
			return '-'
		}
	}, s)
	if out == "" || out == "." || out == ".." {
		return "vol"
	}
	return out
}

func (s *BackupService) ensureImage(ctx context.Context) error {
	s.mu.Lock()
	ready := s.imageReady
	s.mu.Unlock()
	if ready {
		return nil
	}
	if _, _, err := s.docker.ImageInspectWithRaw(ctx, s.image); err == nil {
		s.mu.Lock()
		s.imageReady = true
		s.mu.Unlock()
		return nil
	}
	rc, err := s.docker.ImagePull(ctx, s.image, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("pull %s: %w", s.image, err)
	}
	io.Copy(io.Discard, rc) //nolint:errcheck
	rc.Close()
	s.mu.Lock()
	s.imageReady = true
	s.mu.Unlock()
	return nil
}

func (s *BackupService) sweepStaleHelpers(ctx context.Context) {
	f := filters.NewArgs()
	f.Add("label", vbBackupLabel+"=1")
	list, err := s.docker.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return
	}
	for _, c := range list {
		s.docker.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true}) //nolint:errcheck
	}
}

// runHelper runs a one-shot helper with the given mounts and shell script,
// returning its exit code. The container is always removed.
func (s *BackupService) runHelper(ctx context.Context, mounts []mount.Mount, script string) (int, error) {
	if err := s.ensureImage(ctx); err != nil {
		return -1, err
	}
	created, err := s.docker.ContainerCreate(ctx,
		&container.Config{
			Image:  s.image,
			Cmd:    []string{"sh", "-c", script},
			Labels: map[string]string{vbBackupLabel: "1"},
		},
		&container.HostConfig{Mounts: mounts, NetworkMode: "none", AutoRemove: false},
		nil, nil, "")
	if err != nil {
		return -1, fmt.Errorf("create helper: %w", err)
	}
	defer s.docker.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true}) //nolint:errcheck

	if err := s.docker.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return -1, fmt.Errorf("start helper: %w", err)
	}
	statusCh, errCh := s.docker.ContainerWait(ctx, created.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		return -1, err
	case st := <-statusCh:
		return int(st.StatusCode), nil
	case <-ctx.Done():
		return -1, ctx.Err()
	}
}

// runningConsumers returns the IDs of running, non-helper containers mounting vol.
func (s *BackupService) runningConsumers(ctx context.Context, vol string) []string {
	list, err := s.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil
	}
	var ids []string
	for _, c := range list {
		if c.State != "running" || c.Labels[vbLabel] == "1" || c.Labels[vbBackupLabel] == "1" {
			continue
		}
		for _, m := range c.Mounts {
			if m.Name == vol {
				ids = append(ids, c.ID)
				break
			}
		}
	}
	return ids
}

func (s *BackupService) stopContainers(ctx context.Context, ids []string) {
	for _, id := range ids {
		s.docker.ContainerStop(ctx, id, container.StopOptions{}) //nolint:errcheck
	}
}

func (s *BackupService) startContainers(ids []string) {
	// Detached context: containers must come back even if the operation's deadline
	// elapsed or the client disconnected mid-way.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, id := range ids {
		s.docker.ContainerStart(ctx, id, container.StartOptions{}) //nolint:errcheck
	}
}

// Backup archives a volume to the backup store, applies retention, and records
// it. Runs on a detached context so a caller disconnect cannot abort it. keep<=0
// uses the default retention.
func (s *BackupService) Backup(vol string, stop bool, note string, keep int) (*storage.VolumeBackup, error) {
	if s.backupVolume == "" {
		return nil, errMsg("backup storage not configured")
	}
	if keep <= 0 {
		keep = vbBackupKeep()
	}
	ctx, cancel := context.WithTimeout(context.Background(), vbBackupOpTimeout)
	defer cancel()
	if err := s.ensureImage(ctx); err != nil {
		return nil, err
	}

	running := s.runningConsumers(ctx, vol)
	consistent := len(running) == 0
	if stop && len(running) > 0 {
		s.stopContainers(ctx, running)
		defer s.startContainers(running)
		consistent = true
	}

	// Nanosecond precision so rapid successive backups never collide on a filename.
	rel := path.Join(sanitizeVol(vol), strconv.FormatInt(time.Now().UnixNano(), 10)+".tar.gz")
	dst := path.Join(vbBackupMount, rel)
	tmp := dst + ".tmp"
	// Create the per-volume directory as this (possibly non-root) process. The
	// helper runs as root and writes the archive into it, but retention/delete
	// later os.Remove those files — and unlinking needs write permission on the
	// parent directory, not on the (root-owned) file itself. Owning the directory
	// here keeps prune/delete working when the backend runs unprivileged.
	if err := os.MkdirAll(path.Dir(dst), 0o755); err != nil {
		return nil, fmt.Errorf("prepare backup dir: %w", err)
	}
	script := fmt.Sprintf("set -e\nmkdir -p %s\ntar czf %s -C /v .\nmv %s %s", path.Dir(dst), tmp, tmp, dst)
	mounts := []mount.Mount{
		{Type: mount.TypeVolume, Source: vol, Target: "/v", ReadOnly: true},
		{Type: mount.TypeVolume, Source: s.backupVolume, Target: vbBackupMount},
	}
	code, err := s.runHelper(ctx, mounts, script)
	if err != nil {
		return nil, fmt.Errorf("backup failed: %w", err)
	}
	if code != 0 {
		return nil, errMsg("backup helper exited non-zero")
	}

	var size int64
	if fi, e := os.Stat(dst); e == nil {
		size = fi.Size()
	}
	rec, err := s.db.CreateVolumeBackup(vol, rel, size, consistent, note)
	if err != nil {
		os.Remove(dst) //nolint:errcheck
		return nil, err
	}
	if files, e := s.db.PruneVolumeBackups(vol, keep); e == nil {
		for _, f := range files {
			os.Remove(path.Join(vbBackupMount, f)) //nolint:errcheck
		}
	}
	return rec, nil
}

// Restore replaces a volume's contents with a backup. Destructive: stops the
// consuming container(s), validates the archive BEFORE wiping the target,
// extracts, then restarts the containers. Runs on a detached context.
func (s *BackupService) Restore(vol string, id int64) error {
	rec, err := s.db.GetVolumeBackup(id)
	if err != nil || rec.VolumeName != vol {
		return errMsg("backup not found")
	}
	return s.RestoreInto(id, vol, false)
}

// RestoreInto extracts a backup into targetVol — which may differ from the
// backup's source volume (restore to a new volume). When create is true and the
// target doesn't exist, it is created first. Destructive for the target: the
// archive is validated (tar tzf) BEFORE the target is wiped, so a corrupt archive
// is a no-op. Runs on a detached context.
func (s *BackupService) RestoreInto(id int64, targetVol string, create bool) error {
	if s.backupVolume == "" {
		return errMsg("backup storage not configured")
	}
	targetVol = strings.TrimSpace(targetVol)
	if targetVol == "" {
		return errMsg("target volume required")
	}
	rec, err := s.db.GetVolumeBackup(id)
	if err != nil {
		return errMsg("backup not found")
	}
	src := path.Join(vbBackupMount, path.Clean("/"+rec.File))
	if !strings.HasPrefix(src, vbBackupMount+"/") {
		return errMsg("invalid backup path")
	}

	ctx, cancel := context.WithTimeout(context.Background(), vbBackupOpTimeout)
	defer cancel()
	if err := s.ensureImage(ctx); err != nil {
		return err
	}

	if create {
		if _, e := s.docker.VolumeInspect(ctx, targetVol); e != nil {
			if _, e2 := s.docker.VolumeCreate(ctx, volume.CreateOptions{Name: targetVol}); e2 != nil {
				return fmt.Errorf("create target volume: %w", e2)
			}
		}
	}

	running := s.runningConsumers(ctx, targetVol)
	if len(running) > 0 {
		s.stopContainers(ctx, running)
		defer s.startContainers(running)
	}

	script := fmt.Sprintf("set -e\ntar tzf %s >/dev/null\nrm -rf /v/* /v/..?* /v/.[!.]* 2>/dev/null || true\ntar xzf %s -C /v", src, src)
	mounts := []mount.Mount{
		{Type: mount.TypeVolume, Source: targetVol, Target: "/v"},
		{Type: mount.TypeVolume, Source: s.backupVolume, Target: vbBackupMount, ReadOnly: true},
	}
	code, err := s.runHelper(ctx, mounts, script)
	if err != nil {
		return fmt.Errorf("restore failed: %w", err)
	}
	if code != 0 {
		return errMsg("restore helper exited non-zero (archive may be corrupt; volume left unchanged)")
	}
	return nil
}

// ---- scheduler --------------------------------------------------------------

// RunScheduler runs the opt-in automatic-backup loop until ctx is cancelled. It
// drives both per-volume schedules (needs /backups) and the application backup
// (needs /host-backups); it starts if either destination is available.
func (s *BackupService) RunScheduler(ctx context.Context) {
	if !s.Configured() && !s.AppBackupConfigured() {
		log.Println("[backup] scheduler disabled: neither /backups nor /host-backups mounted")
		return
	}
	tick := backupScheduleTick()
	log.Printf("[backup] scheduler started (tick %s; volumes=%t app=%t)", tick, s.Configured(), s.AppBackupConfigured())
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Println("[backup] scheduler stopped")
			return
		case <-ticker.C:
			if s.Configured() {
				s.runDueSchedules()
			}
			s.runDueAppBackup()
		}
	}
}

// runDueSchedules backs up every enabled volume whose interval has elapsed.
func (s *BackupService) runDueSchedules() {
	scheds, err := s.db.ListEnabledBackupSchedules()
	if err != nil {
		log.Printf("[backup] schedule read error: %v", err)
		return
	}
	now := time.Now().UTC()
	for _, sc := range scheds {
		interval := time.Duration(sc.IntervalHours) * time.Hour
		if interval < time.Hour {
			interval = 24 * time.Hour
		}
		if sc.LastRunAt != nil && now.Sub(sc.LastRunAt.UTC()) < interval {
			continue
		}
		// Skip (silently, without stamping) schedules whose volume no longer
		// exists — e.g. it was deleted. No failure spam; self-heals if it returns.
		ictx, icancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, verr := s.docker.VolumeInspect(ictx, sc.VolumeName)
		icancel()
		if verr != nil {
			continue
		}
		// Stamp the run time BEFORE backing up so a slow/failing backup doesn't
		// retry on every tick.
		s.db.TouchBackupScheduleRun(sc.VolumeName) //nolint:errcheck
		rec, err := s.Backup(sc.VolumeName, sc.StopContainer, "scheduled", sc.Keep)
		if err != nil {
			log.Printf("[backup] scheduled backup failed for %s: %v", sc.VolumeName, err)
			s.db.LogEvent("backup_failed", "system", "volume", sc.VolumeName, "", "", err.Error()) //nolint:errcheck
			continue
		}
		log.Printf("[backup] scheduled backup of %s (%d bytes)", sc.VolumeName, rec.SizeBytes)
		s.db.LogEvent("backup_success", "system", "volume", sc.VolumeName, "", "", "Scheduled backup created") //nolint:errcheck
	}
}

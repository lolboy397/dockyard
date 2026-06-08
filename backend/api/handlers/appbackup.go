package handlers

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"docker-manager/backend/storage"

	"github.com/docker/docker/api/types/volume"
	"github.com/go-chi/chi/v5"
)

// ─────────────────────────────────────────────────────────────────────────────
// Application (system) backup — protects Dockyard's OWN state (DB + encryption
// key + stacks/repos/projects), as opposed to arbitrary user volumes.
//
// The DB is captured with a transactionally-consistent VACUUM INTO snapshot (no
// downtime, no torn WAL copy), then bundled with the data subtrees into a single
// .tar.gz written to a HOST bind-mount (/host-backups) so it survives loss of the
// Docker volumes. Restore is a documented host-side procedure (you cannot hot-
// restore the live DB the running app sits on) — see BACKUP.md.
// ─────────────────────────────────────────────────────────────────────────────

const (
	appBackupMount   = "/host-backups"
	appBackupPrefix  = "dockyard-app-"
	appBackupSuffix  = ".tar.gz"
	appDataDir       = "/data"
	appBackupKeepDef = 7
)

// AppBackupInfo describes one application-backup archive on disk.
type AppBackupInfo struct {
	Name           string    `json:"name"`
	SizeBytes      int64     `json:"size_bytes"`
	CreatedAt      time.Time `json:"created_at"`
	SecretIncluded bool      `json:"secret_included"`
}

// AppBackupConfigured reports whether the host backup directory is mounted.
func (s *BackupService) AppBackupConfigured() bool {
	fi, err := os.Stat(appBackupMount)
	return err == nil && fi.IsDir()
}

// BackupApp writes a consistent application backup to the host backup directory,
// applies retention, and returns the archive's metadata. keep<=0 uses the default.
func (s *BackupService) BackupApp(keep int) (*AppBackupInfo, error) {
	if !s.AppBackupConfigured() {
		return nil, errMsg("application backup directory not available")
	}
	if keep <= 0 {
		keep = appBackupKeepDef
	}

	// 1. Consistent DB snapshot (single clean file, no WAL/SHM).
	snap := filepath.Join(os.TempDir(), "dockyard-db-"+strconv.FormatInt(time.Now().UnixNano(), 10)+".db")
	if err := s.db.SnapshotTo(snap); err != nil {
		return nil, fmt.Errorf("db snapshot: %w", err)
	}
	defer os.Remove(snap) //nolint:errcheck

	// 2. Bundle snapshot + (optional) key + data subtrees into a .tar.gz.
	secretIncluded := !storage.SecretKeyExternal() && fileExists(filepath.Join(appDataDir, "secret.key"))
	flag := "nokey"
	if secretIncluded {
		flag = "withkey"
	}
	name := appBackupPrefix + strconv.FormatInt(time.Now().UnixNano(), 10) + "-" + flag + appBackupSuffix
	dst := filepath.Join(appBackupMount, name)
	tmp := dst + ".tmp"
	if err := writeAppArchive(tmp, snap, secretIncluded); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return nil, fmt.Errorf("build archive: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return nil, fmt.Errorf("finalise archive: %w", err)
	}

	// 3. Retention.
	s.pruneAppBackups(keep)

	info := statAppBackup(name)
	if info == nil {
		return nil, errMsg("backup written but could not be read back")
	}
	return info, nil
}

// writeAppArchive builds the gzipped tar at dst from the DB snapshot and /data.
func writeAppArchive(dst, snapshot string, includeSecret bool) error {
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)

	if err := addFileToTar(tw, snapshot, "docker-manager.db"); err != nil {
		tw.Close()
		gz.Close()
		out.Close()
		return err
	}
	if includeSecret {
		if err := addFileToTar(tw, filepath.Join(appDataDir, "secret.key"), "secret.key"); err != nil {
			tw.Close()
			gz.Close()
			out.Close()
			return err
		}
	}
	for _, sub := range []string{"stacks", "repos", "projects"} {
		p := filepath.Join(appDataDir, sub)
		if dirExists(p) {
			if err := addTreeToTar(tw, p, sub); err != nil {
				tw.Close()
				gz.Close()
				out.Close()
				return err
			}
		}
	}

	// Close in order so all buffered data is flushed; report the first error.
	if err := tw.Close(); err != nil {
		gz.Close()
		out.Close()
		return err
	}
	if err := gz.Close(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ListAppBackups returns the application backups on disk, newest first.
func (s *BackupService) ListAppBackups() []AppBackupInfo {
	out := []AppBackupInfo{}
	if !s.AppBackupConfigured() {
		return out
	}
	entries, err := os.ReadDir(appBackupMount)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !isAppBackupName(e.Name()) {
			continue
		}
		if info := statAppBackup(e.Name()); info != nil {
			out = append(out, *info)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// DeleteAppBackup removes one archive after validating the name.
func (s *BackupService) DeleteAppBackup(name string) error {
	if !isAppBackupName(name) {
		return errMsg("invalid backup name")
	}
	return os.Remove(filepath.Join(appBackupMount, name))
}

// AppBackupPath returns the on-disk path for a named archive (for download).
func (s *BackupService) AppBackupPath(name string) (string, error) {
	if !isAppBackupName(name) {
		return "", errMsg("invalid backup name")
	}
	p := filepath.Join(appBackupMount, name)
	if !fileExists(p) {
		return "", errMsg("backup not found")
	}
	return p, nil
}

// pruneAppBackups keeps the newest `keep` archives and removes the rest.
func (s *BackupService) pruneAppBackups(keep int) {
	list := s.ListAppBackups() // newest first
	for i, b := range list {
		if i >= keep {
			os.Remove(filepath.Join(appBackupMount, b.Name)) //nolint:errcheck
		}
	}
}

// runDueAppBackup runs the scheduled application backup when its interval elapsed.
func (s *BackupService) runDueAppBackup() {
	if !s.AppBackupConfigured() {
		return
	}
	sc, err := s.db.GetAppBackupSchedule()
	if err != nil || !sc.Enabled {
		return
	}
	interval := time.Duration(sc.IntervalHours) * time.Hour
	if interval < time.Hour {
		interval = 24 * time.Hour
	}
	if sc.LastRunAt != nil && time.Now().UTC().Sub(sc.LastRunAt.UTC()) < interval {
		return
	}
	// Stamp before running so a slow/failed backup doesn't retry every tick.
	s.db.TouchAppBackupScheduleRun() //nolint:errcheck
	info, err := s.BackupApp(sc.Keep)
	if err != nil {
		log.Printf("[backup] scheduled application backup failed: %v", err)
		s.db.LogEvent("app_backup_failed", "system", "system", "application", "", "", err.Error()) //nolint:errcheck
		return
	}
	log.Printf("[backup] scheduled application backup created (%s, %d bytes)", info.Name, info.SizeBytes)
	s.db.LogEvent("app_backup_success", "system", "system", "application", "", "", "Scheduled application backup created") //nolint:errcheck
}

// ---- name/stat helpers ------------------------------------------------------

func isAppBackupName(name string) bool {
	return strings.HasPrefix(name, appBackupPrefix) &&
		strings.HasSuffix(name, appBackupSuffix) &&
		!strings.ContainsAny(name, "/\\") &&
		!strings.Contains(name, "..")
}

// statAppBackup parses a backup filename (dockyard-app-<nano>-<flag>.tar.gz) and
// stats it. Returns nil if the name is malformed or the file is missing.
func statAppBackup(name string) *AppBackupInfo {
	if !isAppBackupName(name) {
		return nil
	}
	core := strings.TrimSuffix(strings.TrimPrefix(name, appBackupPrefix), appBackupSuffix)
	idx := strings.LastIndex(core, "-")
	if idx <= 0 {
		return nil
	}
	nano, err := strconv.ParseInt(core[:idx], 10, 64)
	if err != nil {
		return nil
	}
	fi, err := os.Stat(filepath.Join(appBackupMount, name))
	if err != nil {
		return nil
	}
	return &AppBackupInfo{
		Name:           name,
		SizeBytes:      fi.Size(),
		CreatedAt:      time.Unix(0, nano).UTC(),
		SecretIncluded: core[idx+1:] == "withkey",
	}
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func addFileToTar(tw *tar.Writer, srcPath, name string) error {
	fi, err := os.Stat(srcPath)
	if err != nil {
		return err
	}
	hdr, err := tar.FileInfoHeader(fi, "")
	if err != nil {
		return err
	}
	hdr.Name = name
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	f.Close()
	return err
}

// addTreeToTar walks srcDir and writes every regular file / dir / symlink under
// it into the archive, prefixed by `prefix`. Unreadable or special files are
// skipped (best-effort) rather than failing the whole backup.
func addTreeToTar(tw *tar.Writer, srcDir, prefix string) error {
	return filepath.Walk(srcDir, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		rel, rerr := filepath.Rel(srcDir, p)
		if rerr != nil || rel == "." {
			return nil
		}
		name := prefix + "/" + filepath.ToSlash(rel)
		mode := fi.Mode()
		var link string
		switch {
		case mode&os.ModeSymlink != 0:
			link, _ = os.Readlink(p)
		case mode.IsRegular() || fi.IsDir():
			// included
		default:
			return nil // skip sockets/devices/pipes
		}
		hdr, herr := tar.FileInfoHeader(fi, link)
		if herr != nil {
			return nil
		}
		hdr.Name = name
		if fi.IsDir() {
			hdr.Name += "/"
		}
		if werr := tw.WriteHeader(hdr); werr != nil {
			return werr
		}
		if mode.IsRegular() {
			f, oerr := os.Open(p)
			if oerr != nil {
				return nil
			}
			_, cerr := io.Copy(tw, f)
			f.Close()
			if cerr != nil {
				return cerr
			}
		}
		return nil
	})
}

// ---- HTTP handlers (admin-only) ---------------------------------------------

// AppBackupHandlers exposes the application-backup engine over HTTP. Every route
// is admin-only because the archive contains the encryption key and all secrets.
type AppBackupHandlers struct {
	svc *BackupService
	db  *storage.DB
}

func NewAppBackupHandlers(svc *BackupService, db *storage.DB) *AppBackupHandlers {
	return &AppBackupHandlers{svc: svc, db: db}
}

func (h *AppBackupHandlers) guard(w http.ResponseWriter, r *http.Request) bool {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return false
	}
	return true
}

// List returns the application backups plus configuration state.
func (h *AppBackupHandlers) List(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	writeJSON(w, map[string]any{
		"configured":   h.svc.AppBackupConfigured(),
		"key_external": storage.SecretKeyExternal(),
		"backups":      h.svc.ListAppBackups(),
	})
}

// Create produces a new application backup now.
func (h *AppBackupHandlers) Create(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	if !h.svc.AppBackupConfigured() {
		writeError(w, http.StatusNotImplemented, errMsg("application backup directory not mounted"))
		return
	}
	info, err := h.svc.BackupApp(0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, info)
}

// Download streams an application-backup archive.
func (h *AppBackupHandlers) Download(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	name := chi.URLParam(r, "name")
	p, err := h.svc.AppBackupPath(name)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("backup file missing"))
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(name)+`"`)
	if fi, e := f.Stat(); e == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	}
	io.Copy(w, f) //nolint:errcheck
}

// Delete removes an application-backup archive.
func (h *AppBackupHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	if err := h.svc.DeleteAppBackup(chi.URLParam(r, "name")); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
}

// GetSchedule returns the automatic application-backup policy.
func (h *AppBackupHandlers) GetSchedule(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	sc, err := h.db.GetAppBackupSchedule()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"configured": h.svc.AppBackupConfigured(), "schedule": sc})
}

// ---- unified overview (powers the Backups page) -----------------------------

type bkpDest struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Icon  string `json:"icon"`
	Bytes int64  `json:"bytes"`
}

type bkpPolicy struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"` // "volume" | "app"
	Target        string `json:"target"`
	Icon          string `json:"icon"`
	Type          string `json:"type"`
	Cadence       string `json:"cadence"`
	Dest          string `json:"dest"`
	Retention     string `json:"retention"`
	Next          string `json:"next"`
	Enabled       bool   `json:"enabled"`
	IntervalHours int    `json:"interval_hours"`
	Keep          int    `json:"keep"`
	StopContainer bool   `json:"stop_container"`
}

type bkpHistory struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"` // "volume" | "app"
	Target     string    `json:"target"`
	Type       string    `json:"type"`
	SizeBytes  int64     `json:"size_bytes"`
	Dest       string    `json:"dest"`
	StartedAt  time.Time `json:"started_at"`
	Status     string    `json:"status"`
	VolumeName string    `json:"volume_name,omitempty"`
	BackupID   int64     `json:"backup_id,omitempty"`
	Name       string    `json:"name,omitempty"` // app archive filename
}

type bkpStats struct {
	ProtectedVolumes    int        `json:"protected_volumes"`
	TotalVolumes        int        `json:"total_volumes"`
	StorageBytes        int64      `json:"storage_bytes"`
	LastBackupAt        *time.Time `json:"last_backup_at"`
	LastBackupTarget    string     `json:"last_backup_target"`
	NextScheduledAt     *time.Time `json:"next_scheduled_at"`
	NextScheduledTarget string     `json:"next_scheduled_target"`
}

type bkpOverview struct {
	Configured   bool         `json:"configured"`
	KeyExternal  bool         `json:"key_external"`
	Stats        bkpStats     `json:"stats"`
	Destinations []bkpDest    `json:"destinations"`
	Policies     []bkpPolicy  `json:"policies"`
	Recent       []bkpHistory `json:"recent"`
}

// Overview aggregates the real state behind the Backups page: per-volume
// schedules + backups and the application backup, mapped onto policies, a storage
// breakdown, headline stats, and a unified recent-runs list.
func (h *AppBackupHandlers) Overview(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	ctx := r.Context()
	ov := bkpOverview{
		Configured:   h.svc.AppBackupConfigured(),
		KeyExternal:  storage.SecretKeyExternal(),
		Destinations: []bkpDest{},
		Policies:     []bkpPolicy{},
		Recent:       []bkpHistory{},
	}

	var hostBytes, volBytes int64
	var lastAt, nextAt *time.Time
	var lastTarget, nextTarget string
	considerLast := func(t time.Time, target string) {
		if lastAt == nil || t.After(*lastAt) {
			tt := t
			lastAt, lastTarget = &tt, target
		}
	}
	considerNext := func(t time.Time, target string) {
		if nextAt == nil || t.Before(*nextAt) {
			tt := t
			nextAt, nextTarget = &tt, target
		}
	}

	// Application backup policy (always listed first) + its archives.
	appSc, _ := h.db.GetAppBackupSchedule()
	appNext := "Paused"
	if appSc.Enabled {
		nt := nextRunTime(appSc.LastRunAt, appSc.IntervalHours)
		appNext = relFuture(nt)
		considerNext(nt, "Application")
	}
	ov.Policies = append(ov.Policies, bkpPolicy{
		ID: "app", Kind: "app", Target: "Application", Icon: "box",
		Type: "Full", Cadence: cadenceLabel(appSc.IntervalHours), Dest: "Host directory",
		Retention: fmt.Sprintf("keep %d", appSc.Keep), Next: appNext, Enabled: appSc.Enabled,
		IntervalHours: appSc.IntervalHours, Keep: appSc.Keep,
	})
	for _, ab := range h.svc.ListAppBackups() {
		hostBytes += ab.SizeBytes
		considerLast(ab.CreatedAt, "Application")
		ov.Recent = append(ov.Recent, bkpHistory{
			ID: ab.Name, Kind: "app", Target: "Application",
			Type:      ifStr(ab.SecretIncluded, "Full + key", "Full"),
			SizeBytes: ab.SizeBytes, Dest: "Host directory", StartedAt: ab.CreatedAt,
			Status: "Completed", Name: ab.Name,
		})
	}

	// Volumes: schedules → policies, backups → history + storage.
	vols, _ := h.svc.docker.VolumeList(ctx, volume.ListOptions{})
	total, protected := 0, 0
	for _, v := range vols.Volumes {
		total++
		prot := false
		if sc, _ := h.db.GetBackupSchedule(v.Name); sc != nil {
			next := "Paused"
			if sc.Enabled {
				prot = true
				nt := nextRunTime(sc.LastRunAt, sc.IntervalHours)
				next = relFuture(nt)
				considerNext(nt, v.Name)
			}
			ov.Policies = append(ov.Policies, bkpPolicy{
				ID: "vol:" + v.Name, Kind: "volume", Target: v.Name, Icon: "database",
				Type:    ifStr(sc.StopContainer, "Consistent", "Hot copy"),
				Cadence: cadenceLabel(sc.IntervalHours), Dest: "Backup volume",
				Retention: fmt.Sprintf("keep %d", sc.Keep), Next: next, Enabled: sc.Enabled,
				IntervalHours: sc.IntervalHours, Keep: sc.Keep, StopContainer: sc.StopContainer,
			})
		}
		bks, _ := h.db.ListVolumeBackups(v.Name)
		if len(bks) > 0 {
			prot = true
		}
		for _, b := range bks {
			volBytes += b.SizeBytes
			considerLast(b.CreatedAt, v.Name)
			ov.Recent = append(ov.Recent, bkpHistory{
				ID: fmt.Sprintf("v%d", b.ID), Kind: "volume", Target: v.Name,
				Type:      ifStr(b.Consistent, "Consistent", "Hot copy"),
				SizeBytes: b.SizeBytes, Dest: "Backup volume", StartedAt: b.CreatedAt,
				Status: "Completed", VolumeName: v.Name, BackupID: b.ID,
			})
		}
		if prot {
			protected++
		}
	}

	ov.Stats = bkpStats{
		ProtectedVolumes: protected, TotalVolumes: total, StorageBytes: hostBytes + volBytes,
		LastBackupAt: lastAt, LastBackupTarget: lastTarget,
		NextScheduledAt: nextAt, NextScheduledTarget: nextTarget,
	}
	ov.Destinations = []bkpDest{
		{ID: "host", Label: "Host directory", Icon: "hard-drive", Bytes: hostBytes},
		{ID: "volume", Label: "Backup volume", Icon: "database", Bytes: volBytes},
	}
	sort.Slice(ov.Recent, func(i, j int) bool { return ov.Recent[i].StartedAt.After(ov.Recent[j].StartedAt) })
	if len(ov.Recent) > 50 {
		ov.Recent = ov.Recent[:50]
	}
	writeJSON(w, ov)
}

func ifStr(cond bool, yes, no string) string {
	if cond {
		return yes
	}
	return no
}

func cadenceLabel(h int) string {
	switch {
	case h <= 1:
		return "Hourly"
	case h == 24:
		return "Daily"
	case h == 168:
		return "Weekly"
	case h == 72:
		return "Every 3 days"
	case h%24 == 0:
		return fmt.Sprintf("Every %d days", h/24)
	default:
		return fmt.Sprintf("Every %dh", h)
	}
}

func nextRunTime(last *time.Time, intervalH int) time.Time {
	iv := time.Duration(intervalH) * time.Hour
	if iv < time.Hour {
		iv = 24 * time.Hour
	}
	if last == nil {
		return time.Now()
	}
	return last.Add(iv)
}

func relFuture(t time.Time) string {
	d := time.Until(t)
	if d <= 0 {
		return "due now"
	}
	if d < time.Hour {
		return fmt.Sprintf("in %dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("in %dh %dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("in %dd", int(d.Hours())/24)
}

// SetSchedule creates or updates the automatic application-backup policy.
func (h *AppBackupHandlers) SetSchedule(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	var body struct {
		Enabled       bool `json:"enabled"`
		IntervalHours int  `json:"interval_hours"`
		Keep          int  `json:"keep"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	if body.IntervalHours < 1 || body.IntervalHours > 24*90 {
		writeError(w, http.StatusBadRequest, errMsg("interval_hours must be between 1 and 2160"))
		return
	}
	if body.Keep < 1 || body.Keep > 100 {
		writeError(w, http.StatusBadRequest, errMsg("keep must be between 1 and 100"))
		return
	}
	if err := h.db.UpsertAppBackupSchedule(storage.AppBackupSchedule{
		Enabled: body.Enabled, IntervalHours: body.IntervalHours, Keep: body.Keep,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	saved, _ := h.db.GetAppBackupSchedule()
	writeJSON(w, map[string]any{"configured": true, "schedule": saved})
}

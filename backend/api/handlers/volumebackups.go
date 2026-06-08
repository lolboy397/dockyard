package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

// HTTP handlers for volume backup / restore. The orchestration lives in
// BackupService (shared with the scheduler); these are thin wrappers.

// ListBackups returns a volume's backups, newest first.
func (h *VolumeHandlers) ListBackups(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	backups, err := h.db.ListVolumeBackups(name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"configured": h.backup.Configured(), "backups": backups})
}

// CreateBackup archives a volume. Body: {stop_container?: bool, note?: string}.
func (h *VolumeHandlers) CreateBackup(w http.ResponseWriter, r *http.Request) {
	if !h.backup.Configured() {
		writeError(w, http.StatusNotImplemented, errMsg("backup storage not configured"))
		return
	}
	name := chi.URLParam(r, "name")
	var body struct {
		StopContainer bool   `json:"stop_container"`
		Note          string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body) // optional body

	rec, err := h.backup.Backup(name, body.StopContainer, strings.TrimSpace(body.Note), 0)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, rec)
}

// RestoreBackup replaces a volume's contents with a backup (destructive).
func (h *VolumeHandlers) RestoreBackup(w http.ResponseWriter, r *http.Request) {
	if !h.backup.Configured() {
		writeError(w, http.StatusNotImplemented, errMsg("backup storage not configured"))
		return
	}
	name := chi.URLParam(r, "name")
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid backup id"))
		return
	}
	if rec, gerr := h.db.GetVolumeBackup(id); gerr != nil || rec.VolumeName != name {
		writeError(w, http.StatusNotFound, errMsg("backup not found"))
		return
	}
	// Optional body: restore into a different (new) volume instead of in place.
	var body struct {
		TargetVolume string `json:"target_volume"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	target := strings.TrimSpace(body.TargetVolume)
	var rerr error
	if target != "" && target != name {
		rerr = h.backup.RestoreInto(id, target, true) // create the new volume if missing
	} else {
		rerr = h.backup.Restore(name, id)
	}
	if rerr != nil {
		writeError(w, http.StatusInternalServerError, rerr)
		return
	}
	writeJSON(w, map[string]string{"status": "restored"})
}

// DeleteBackup removes a backup's archive and catalogue row.
func (h *VolumeHandlers) DeleteBackup(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid backup id"))
		return
	}
	rec, err := h.db.GetVolumeBackup(id)
	if err != nil || rec.VolumeName != name {
		writeError(w, http.StatusNotFound, errMsg("backup not found"))
		return
	}
	if clean := path.Join(vbBackupMount, path.Clean("/"+rec.File)); strings.HasPrefix(clean, vbBackupMount+"/") {
		os.Remove(clean) //nolint:errcheck
	}
	if err := h.db.DeleteVolumeBackup(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
}

// DownloadBackup streams a backup archive to the client.
func (h *VolumeHandlers) DownloadBackup(w http.ResponseWriter, r *http.Request) {
	if !h.backup.Configured() {
		writeError(w, http.StatusNotImplemented, errMsg("backup storage not configured"))
		return
	}
	name := chi.URLParam(r, "name")
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid backup id"))
		return
	}
	rec, err := h.db.GetVolumeBackup(id)
	if err != nil || rec.VolumeName != name {
		writeError(w, http.StatusNotFound, errMsg("backup not found"))
		return
	}
	clean := path.Join(vbBackupMount, path.Clean("/"+rec.File))
	if !strings.HasPrefix(clean, vbBackupMount+"/") {
		writeError(w, http.StatusBadRequest, errMsg("invalid backup path"))
		return
	}
	f, err := os.Open(clean)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("backup file missing"))
		return
	}
	defer f.Close()

	filename := sanitizeFilename(sanitizeVol(name) + "-" + strconv.FormatInt(rec.CreatedAt.Unix(), 10) + ".tar.gz")
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	if fi, e := f.Stat(); e == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	}
	io.Copy(w, f) //nolint:errcheck
}

// ---- schedule ---------------------------------------------------------------

// DeleteSchedule removes a volume's automatic-backup policy entirely.
func (h *VolumeHandlers) DeleteSchedule(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := h.db.DeleteBackupSchedule(name); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
}

// GetBackupSchedule returns a volume's automatic-backup policy (a disabled
// default when none is configured).
func (h *VolumeHandlers) GetBackupSchedule(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sc, err := h.db.GetBackupSchedule(name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if sc == nil {
		sc = &storage.BackupSchedule{VolumeName: name, Enabled: false, IntervalHours: 24, Keep: 10, StopContainer: true}
	}
	writeJSON(w, map[string]any{"configured": h.backup.Configured(), "schedule": sc})
}

// SetBackupSchedule creates or updates a volume's automatic-backup policy.
func (h *VolumeHandlers) SetBackupSchedule(w http.ResponseWriter, r *http.Request) {
	if !h.backup.Configured() {
		writeError(w, http.StatusNotImplemented, errMsg("backup storage not configured"))
		return
	}
	name := chi.URLParam(r, "name")
	var body struct {
		Enabled       bool `json:"enabled"`
		IntervalHours int  `json:"interval_hours"`
		Keep          int  `json:"keep"`
		StopContainer bool `json:"stop_container"`
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
	sc := storage.BackupSchedule{
		VolumeName:    name,
		Enabled:       body.Enabled,
		IntervalHours: body.IntervalHours,
		Keep:          body.Keep,
		StopContainer: body.StopContainer,
	}
	if err := h.db.UpsertBackupSchedule(sc); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	saved, _ := h.db.GetBackupSchedule(name)
	writeJSON(w, map[string]any{"configured": true, "schedule": saved})
}

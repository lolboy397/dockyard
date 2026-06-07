package storage

import (
	"database/sql"
	"errors"
	"time"
)

// VolumeBackup is one point-in-time archive of a Docker volume's contents.
type VolumeBackup struct {
	ID         int64     `json:"id"`
	VolumeName string    `json:"volume_name"`
	File       string    `json:"file"`        // path relative to the backup root (/backups)
	SizeBytes  int64     `json:"size_bytes"`
	Consistent bool      `json:"consistent"`  // true if the consuming container(s) were stopped during the backup
	Note       string    `json:"note"`
	CreatedAt  time.Time `json:"created_at"`
}

// migrateV21 creates the volume-backup catalogue table.
func (db *DB) migrateV21() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS volume_backups (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			volume_name TEXT NOT NULL,
			file        TEXT NOT NULL,
			size_bytes  INTEGER NOT NULL DEFAULT 0,
			consistent  INTEGER NOT NULL DEFAULT 0,
			note        TEXT NOT NULL DEFAULT '',
			created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_volume_backups_vol ON volume_backups(volume_name, id DESC);
	`)
	return err
}

// CreateVolumeBackup records a completed backup and returns the stored row.
func (db *DB) CreateVolumeBackup(vol, file string, size int64, consistent bool, note string) (*VolumeBackup, error) {
	c := 0
	if consistent {
		c = 1
	}
	res, err := db.conn.Exec(
		`INSERT INTO volume_backups (volume_name, file, size_bytes, consistent, note) VALUES (?, ?, ?, ?, ?)`,
		vol, file, size, c, note)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return db.GetVolumeBackup(id)
}

// ListVolumeBackups returns a volume's backups, newest first.
func (db *DB) ListVolumeBackups(vol string) ([]VolumeBackup, error) {
	rows, err := db.conn.Query(
		`SELECT id, volume_name, file, size_bytes, consistent, note, created_at
		 FROM volume_backups WHERE volume_name=? ORDER BY id DESC`, vol)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []VolumeBackup{}
	for rows.Next() {
		b, err := scanVolumeBackup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

// GetVolumeBackup returns a single backup by id.
func (db *DB) GetVolumeBackup(id int64) (*VolumeBackup, error) {
	row := db.conn.QueryRow(
		`SELECT id, volume_name, file, size_bytes, consistent, note, created_at FROM volume_backups WHERE id=?`, id)
	return scanVolumeBackup(row)
}

// DeleteVolumeBackup removes a backup's catalogue row (the file is deleted by the caller).
func (db *DB) DeleteVolumeBackup(id int64) error {
	_, err := db.conn.Exec(`DELETE FROM volume_backups WHERE id=?`, id)
	return err
}

// PruneVolumeBackups keeps the newest keepN backups for a volume and returns the
// `file` paths of the rows it deleted so the caller can remove them from disk.
func (db *DB) PruneVolumeBackups(vol string, keepN int) ([]string, error) {
	if keepN < 1 {
		keepN = 1
	}
	rows, err := db.conn.Query(
		`SELECT file FROM volume_backups
		 WHERE volume_name=? AND id NOT IN (
			SELECT id FROM volume_backups WHERE volume_name=? ORDER BY id DESC LIMIT ?
		 )`, vol, vol, keepN)
	if err != nil {
		return nil, err
	}
	var files []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			rows.Close()
			return nil, err
		}
		files = append(files, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, nil
	}
	_, err = db.conn.Exec(
		`DELETE FROM volume_backups
		 WHERE volume_name=? AND id NOT IN (
			SELECT id FROM volume_backups WHERE volume_name=? ORDER BY id DESC LIMIT ?
		 )`, vol, vol, keepN)
	return files, err
}

// rowScanner is satisfied by both *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanVolumeBackup(s rowScanner) (*VolumeBackup, error) {
	var b VolumeBackup
	var consistent int
	var ts string
	if err := s.Scan(&b.ID, &b.VolumeName, &b.File, &b.SizeBytes, &consistent, &b.Note, &ts); err != nil {
		return nil, err
	}
	b.Consistent = consistent != 0
	b.CreatedAt = parseDBTime(ts)
	return &b, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled (opt-in) backups
// ─────────────────────────────────────────────────────────────────────────────

// BackupSchedule is a per-volume automatic-backup policy. Opt-in: a volume has
// no schedule until one is saved with Enabled=true.
type BackupSchedule struct {
	VolumeName    string     `json:"volume_name"`
	Enabled       bool       `json:"enabled"`
	IntervalHours int        `json:"interval_hours"` // how often to back up
	Keep          int        `json:"keep"`           // retention (newest N kept)
	StopContainer bool       `json:"stop_container"` // quiesce for a consistent copy
	LastRunAt     *time.Time `json:"last_run_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// migrateV22 creates the per-volume backup-schedule table.
func (db *DB) migrateV22() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS volume_backup_schedules (
			volume_name    TEXT PRIMARY KEY,
			enabled        INTEGER NOT NULL DEFAULT 0,
			interval_hours INTEGER NOT NULL DEFAULT 24,
			keep           INTEGER NOT NULL DEFAULT 10,
			stop_container INTEGER NOT NULL DEFAULT 1,
			last_run_at    DATETIME,
			updated_at     DATETIME NOT NULL DEFAULT (datetime('now'))
		);
	`)
	return err
}

// GetBackupSchedule returns a volume's schedule, or nil if none is configured.
func (db *DB) GetBackupSchedule(vol string) (*BackupSchedule, error) {
	row := db.conn.QueryRow(
		`SELECT volume_name, enabled, interval_hours, keep, stop_container, last_run_at, updated_at
		 FROM volume_backup_schedules WHERE volume_name=?`, vol)
	sc, err := scanBackupSchedule(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil // opt-in: no schedule configured yet
	}
	return sc, err
}

// UpsertBackupSchedule creates or updates a volume's schedule.
func (db *DB) UpsertBackupSchedule(s BackupSchedule) error {
	_, err := db.conn.Exec(`
		INSERT INTO volume_backup_schedules
			(volume_name, enabled, interval_hours, keep, stop_container, updated_at)
		VALUES (?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(volume_name) DO UPDATE SET
			enabled=excluded.enabled,
			interval_hours=excluded.interval_hours,
			keep=excluded.keep,
			stop_container=excluded.stop_container,
			updated_at=datetime('now')`,
		s.VolumeName, boolToInt(s.Enabled), s.IntervalHours, s.Keep, boolToInt(s.StopContainer))
	return err
}

// ListEnabledBackupSchedules returns every schedule with Enabled=true (for the scheduler).
func (db *DB) ListEnabledBackupSchedules() ([]BackupSchedule, error) {
	rows, err := db.conn.Query(
		`SELECT volume_name, enabled, interval_hours, keep, stop_container, last_run_at, updated_at
		 FROM volume_backup_schedules WHERE enabled=1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BackupSchedule{}
	for rows.Next() {
		s, err := scanBackupSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// TouchBackupScheduleRun stamps a schedule's last_run_at to now. Called before a
// scheduled run so a slow/failed backup doesn't retry on every tick.
func (db *DB) TouchBackupScheduleRun(vol string) error {
	_, err := db.conn.Exec(`UPDATE volume_backup_schedules SET last_run_at=datetime('now') WHERE volume_name=?`, vol)
	return err
}

func scanBackupSchedule(s rowScanner) (*BackupSchedule, error) {
	var sc BackupSchedule
	var enabled, stop int
	var last *string
	var updated string
	if err := s.Scan(&sc.VolumeName, &enabled, &sc.IntervalHours, &sc.Keep, &stop, &last, &updated); err != nil {
		return nil, err
	}
	sc.Enabled = enabled != 0
	sc.StopContainer = stop != 0
	if last != nil && *last != "" {
		t := parseDBTime(*last)
		sc.LastRunAt = &t
	}
	sc.UpdatedAt = parseDBTime(updated)
	return &sc, nil
}

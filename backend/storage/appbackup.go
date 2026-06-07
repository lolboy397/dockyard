package storage

import (
	"database/sql"
	"errors"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Application (system) backup support
//
// Unlike per-volume backups, the application backup protects Dockyard's OWN
// state (the SQLite DB, the encryption key, stacks/repos/projects). The catalogue
// of archives lives on the filesystem (so it survives even a lost DB); only the
// opt-in schedule is persisted here.
// ─────────────────────────────────────────────────────────────────────────────

// AppBackupSchedule is the single global automatic application-backup policy.
// Opt-in: nothing runs until a row with Enabled=true is saved.
type AppBackupSchedule struct {
	Enabled       bool       `json:"enabled"`
	IntervalHours int        `json:"interval_hours"`
	Keep          int        `json:"keep"`
	LastRunAt     *time.Time `json:"last_run_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// migrateV23 creates the single-row application-backup schedule table.
func (db *DB) migrateV23() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS app_backup_schedule (
			id             INTEGER PRIMARY KEY CHECK (id = 1),
			enabled        INTEGER NOT NULL DEFAULT 0,
			interval_hours INTEGER NOT NULL DEFAULT 24,
			keep           INTEGER NOT NULL DEFAULT 7,
			last_run_at    DATETIME,
			updated_at     DATETIME NOT NULL DEFAULT (datetime('now'))
		);
	`)
	return err
}

// GetAppBackupSchedule returns the schedule, or a disabled default when none is set.
func (db *DB) GetAppBackupSchedule() (AppBackupSchedule, error) {
	row := db.conn.QueryRow(
		`SELECT enabled, interval_hours, keep, last_run_at, updated_at FROM app_backup_schedule WHERE id=1`)
	var sc AppBackupSchedule
	var enabled int
	var last *string
	var updated *string
	err := row.Scan(&enabled, &sc.IntervalHours, &sc.Keep, &last, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return AppBackupSchedule{Enabled: false, IntervalHours: 24, Keep: 7}, nil
	}
	if err != nil {
		return AppBackupSchedule{}, err
	}
	sc.Enabled = enabled != 0
	if last != nil && *last != "" {
		t := parseDBTime(*last)
		sc.LastRunAt = &t
	}
	if updated != nil {
		sc.UpdatedAt = parseDBTime(*updated)
	}
	return sc, nil
}

// UpsertAppBackupSchedule creates or updates the application-backup schedule.
func (db *DB) UpsertAppBackupSchedule(s AppBackupSchedule) error {
	_, err := db.conn.Exec(`
		INSERT INTO app_backup_schedule (id, enabled, interval_hours, keep, updated_at)
		VALUES (1, ?, ?, ?, datetime('now'))
		ON CONFLICT(id) DO UPDATE SET
			enabled=excluded.enabled,
			interval_hours=excluded.interval_hours,
			keep=excluded.keep,
			updated_at=datetime('now')`,
		boolToInt(s.Enabled), s.IntervalHours, s.Keep)
	return err
}

// TouchAppBackupScheduleRun stamps last_run_at to now, before a scheduled run, so
// a slow/failed backup doesn't retry on every tick.
func (db *DB) TouchAppBackupScheduleRun() error {
	_, err := db.conn.Exec(`UPDATE app_backup_schedule SET last_run_at=datetime('now') WHERE id=1`)
	return err
}

// SnapshotTo writes a transactionally-consistent copy of the database to path
// using SQLite's VACUUM INTO (safe to run while the app is serving; produces a
// single clean file with no WAL/SHM sidecars). The target file must not exist.
func (db *DB) SnapshotTo(path string) error {
	_, err := db.conn.Exec("VACUUM INTO ?", path)
	return err
}

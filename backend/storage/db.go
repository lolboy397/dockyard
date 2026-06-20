package storage

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// DB is the application database wrapper.
type DB struct {
	conn *sql.DB
}

// Open opens (or creates) the SQLite database at the given path and runs migrations.
func Open(path string) (*DB, error) {
	dsn := path
	// For on-disk databases, enable WAL (better read/write concurrency and
	// durability) and a busy_timeout so a transient lock waits briefly instead
	// of failing immediately. Skipped for the in-memory test DB.
	if path != ":memory:" && !strings.HasPrefix(path, "file::memory:") {
		dsn = path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	}
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	conn.SetMaxOpenConns(1) // SQLite is single-writer
	db := &DB{conn: conn}
	if err := db.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := db.migrateV2(); err != nil {
		return nil, fmt.Errorf("migrateV2: %w", err)
	}
	if err := db.migrateV3(); err != nil {
		return nil, fmt.Errorf("migrateV3: %w", err)
	}
	if err := db.migrateV4(); err != nil {
		return nil, fmt.Errorf("migrateV4: %w", err)
	}
	if err := db.migrateV5(); err != nil {
		return nil, fmt.Errorf("migrateV5: %w", err)
	}
	if err := db.migrateV6(); err != nil {
		return nil, fmt.Errorf("migrateV6: %w", err)
	}
	if err := db.migrateV7(); err != nil {
		return nil, fmt.Errorf("migrateV7: %w", err)
	}
	if err := db.migrateV8(); err != nil {
		return nil, fmt.Errorf("migrateV8: %w", err)
	}
	if err := db.migrateV9(); err != nil {
		return nil, fmt.Errorf("migrateV9: %w", err)
	}
	if err := db.migrateV10(); err != nil {
		return nil, fmt.Errorf("migrateV10: %w", err)
	}
	if err := db.migrateV11(); err != nil {
		return nil, fmt.Errorf("migrateV11: %w", err)
	}
	if err := db.migrateV12(); err != nil {
		return nil, fmt.Errorf("migrateV12: %w", err)
	}
	if err := db.migrateV13(); err != nil {
		return nil, fmt.Errorf("migrateV13: %w", err)
	}
	if err := db.migrateV14(); err != nil {
		return nil, fmt.Errorf("migrateV14: %w", err)
	}
	if err := db.migrateV15(); err != nil {
		return nil, fmt.Errorf("migrateV15: %w", err)
	}
	if err := db.migrateV16(); err != nil {
		return nil, fmt.Errorf("migrateV16: %w", err)
	}
	if err := db.migrateV17(); err != nil {
		return nil, fmt.Errorf("migrateV17: %w", err)
	}
	if err := db.migrateV18(); err != nil {
		return nil, fmt.Errorf("migrateV18: %w", err)
	}
	// V20 adds the richer user/session columns BEFORE V19 seeds roles, because the
	// V19 operator→maintainer migration touches users (ordering is not otherwise
	// significant — both are idempotent).
	if err := db.migrateV20(); err != nil {
		return nil, fmt.Errorf("migrateV20: %w", err)
	}
	if err := db.migrateV19(); err != nil {
		return nil, fmt.Errorf("migrateV19: %w", err)
	}
	if err := db.migrateV21(); err != nil {
		return nil, fmt.Errorf("migrateV21: %w", err)
	}
	if err := db.migrateV22(); err != nil {
		return nil, fmt.Errorf("migrateV22: %w", err)
	}
	if err := db.migrateV23(); err != nil {
		return nil, fmt.Errorf("migrateV23: %w", err)
	}
	initSecretKey(path)
	return db, nil
}

// migrateV18 adds the persisted "update available" flag to watched_images so the
// per-container Image-updates UI can show state without scraping the event log.
func (db *DB) migrateV18() error {
	_, err := db.conn.Exec(`ALTER TABLE watched_images ADD COLUMN update_available INTEGER NOT NULL DEFAULT 0`)
	if err != nil && !strings.Contains(err.Error(), "duplicate column") {
		return err
	}
	return nil
}

func (db *DB) migrate() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS events (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
			kind        TEXT NOT NULL,
			container_id TEXT,
			image       TEXT,
			message     TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);
		CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

		CREATE TABLE IF NOT EXISTS watched_images (
			id               INTEGER PRIMARY KEY AUTOINCREMENT,
			container_id     TEXT NOT NULL UNIQUE,
			container_name   TEXT NOT NULL,
			image            TEXT NOT NULL,
			current_digest   TEXT,
			check_interval   INTEGER NOT NULL DEFAULT 300,
			auto_update      INTEGER NOT NULL DEFAULT 1,
			enabled          INTEGER NOT NULL DEFAULT 1,
			last_checked_at  DATETIME,
			created_at       DATETIME NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS builds (
			id           TEXT PRIMARY KEY,
			name         TEXT NOT NULL,
			tag          TEXT NOT NULL,
			status       TEXT NOT NULL DEFAULT 'queued',
			progress     INTEGER NOT NULL DEFAULT 0,
			step         TEXT NOT NULL DEFAULT '',
			total_steps  INTEGER NOT NULL DEFAULT 0,
			current_step INTEGER NOT NULL DEFAULT 0,
			duration_ms  INTEGER NOT NULL DEFAULT 0,
			cache_pct    INTEGER NOT NULL DEFAULT 0,
			initiated_by TEXT NOT NULL DEFAULT 'user',
			logs         TEXT NOT NULL DEFAULT '',
			started_at   TEXT,
			finished_at  TEXT,
			created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
		);

		CREATE INDEX IF NOT EXISTS idx_builds_status     ON builds(status);
		CREATE INDEX IF NOT EXISTS idx_builds_created_at ON builds(created_at);

		CREATE TABLE IF NOT EXISTS registries (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			name         TEXT NOT NULL,
			url          TEXT NOT NULL UNIQUE,
			type         TEXT NOT NULL DEFAULT 'custom',
			username     TEXT NOT NULL DEFAULT '',
			images_count INTEGER NOT NULL DEFAULT 0,
			status       TEXT NOT NULL DEFAULT 'unknown',
			created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
		);

		CREATE TABLE IF NOT EXISTS build_definitions (
			id              TEXT PRIMARY KEY,
			name            TEXT NOT NULL,
			tag             TEXT NOT NULL DEFAULT 'latest',
			source_type     TEXT NOT NULL DEFAULT 'inline',
			git_url         TEXT NOT NULL DEFAULT '',
			git_branch      TEXT NOT NULL DEFAULT 'main',
			dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
			dockerfile      TEXT NOT NULL DEFAULT '',
			push_to_registry INTEGER NOT NULL DEFAULT 0,
			registry_url    TEXT NOT NULL DEFAULT '',
			created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
		);
	`)
	return err
}

// Close closes the database connection.
func (db *DB) Close() error {
	return db.conn.Close()
}

// migrateV2 applies additive schema changes to existing databases.
func (db *DB) migrateV2() error {
	// Add definition_id to builds if it doesn't exist yet.
	db.conn.Exec(`ALTER TABLE builds ADD COLUMN definition_id TEXT`) //nolint:errcheck
	return nil
}

// migrateV3 creates the git source-control tables.
func (db *DB) migrateV3() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS git_repos (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at   DATETIME NOT NULL DEFAULT (datetime('now')),
			name         TEXT NOT NULL UNIQUE,
			path         TEXT NOT NULL UNIQUE,
			remote_url   TEXT NOT NULL DEFAULT '',
			username     TEXT NOT NULL DEFAULT '',
			token        TEXT NOT NULL DEFAULT '',
			author_name  TEXT NOT NULL DEFAULT '',
			author_email TEXT NOT NULL DEFAULT '',
			description  TEXT NOT NULL DEFAULT ''
		);
	`)
	return err
}

// migrateV4 creates the local projects table.
func (db *DB) migrateV4() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at   DATETIME NOT NULL DEFAULT (datetime('now')),
			updated_at   DATETIME NOT NULL DEFAULT (datetime('now')),
			name         TEXT NOT NULL UNIQUE,
			description  TEXT NOT NULL DEFAULT '',
			path         TEXT NOT NULL UNIQUE,
			type         TEXT NOT NULL DEFAULT 'unknown',
			status       TEXT NOT NULL DEFAULT 'idle',
			image_tag    TEXT NOT NULL DEFAULT '',
			container_id TEXT NOT NULL DEFAULT '',
			build_log    TEXT NOT NULL DEFAULT '',
			run_log      TEXT NOT NULL DEFAULT ''
		);
	`)
	return err
}

// ---- Event helpers ----------------------------------------------------------

// Event represents a logged system event.
type Event struct {
	ID         int64     `json:"id"`
	CreatedAt  time.Time `json:"created_at"`
	Kind       string    `json:"kind"`
	Actor      string    `json:"actor"`
	ObjectType string    `json:"object_type"`
	ObjectName string    `json:"object_name"`
	ContainerID string   `json:"container_id,omitempty"`
	Image      string    `json:"image,omitempty"`
	Message    string    `json:"message"`
}

// LogEvent inserts a new event record.
func (db *DB) LogEvent(kind, actor, objectType, objectName, containerID, image, message string) error {
	_, err := db.conn.Exec(
		`INSERT INTO events (kind, actor, object_type, object_name, container_id, image, message) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		kind, actor, objectType, objectName, containerID, image, message,
	)
	return err
}

// PruneEvents deletes events older than keepSeconds. The events table is
// append-only (every audited mutation + daemon event), so without pruning it
// grows without bound. Returns the number of rows deleted.
func (db *DB) PruneEvents(keepSeconds int) (int64, error) {
	res, err := db.conn.Exec(
		`DELETE FROM events WHERE created_at < datetime('now', ?)`,
		fmt.Sprintf("-%d seconds", keepSeconds),
	)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// GetEvents returns events with optional kind filter, newest first.
func (db *DB) GetEvents(kind string, limit int) ([]Event, error) {
	// Always exclude noisy low-level Docker events that add no signal.
	noiseFilter := ` (kind NOT LIKE 'exec_%' AND kind NOT LIKE 'health_status%' AND kind != 'top')`

	query := `SELECT id, created_at, kind,
			COALESCE(actor,'engine'),
			COALESCE(object_type,''),
			COALESCE(object_name,''),
			COALESCE(container_id,''),
			COALESCE(image,''),
			COALESCE(message,'')
		FROM events`
	args := []any{}
	if kind != "" {
		query += ` WHERE` + noiseFilter + ` AND kind = ?`
		args = append(args, kind)
	} else {
		query += ` WHERE` + noiseFilter
	}
	query += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)

	rows, err := db.conn.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var e Event
		var ts string
		if err := rows.Scan(&e.ID, &ts, &e.Kind, &e.Actor, &e.ObjectType, &e.ObjectName, &e.ContainerID, &e.Image, &e.Message); err != nil {
			return nil, err
		}
		e.CreatedAt = parseDBTime(ts)
		events = append(events, e)
	}
	return events, rows.Err()
}

// EventsByActor returns the most recent events attributed to a given actor
// (username), newest first — backing a member's Activity tab.
func (db *DB) EventsByActor(actor string, limit int) ([]Event, error) {
	noiseFilter := ` (kind NOT LIKE 'exec_%' AND kind NOT LIKE 'health_status%' AND kind != 'top')`
	rows, err := db.conn.Query(`
		SELECT id, created_at, kind,
			COALESCE(actor,''), COALESCE(object_type,''), COALESCE(object_name,''),
			COALESCE(container_id,''), COALESCE(image,''), COALESCE(message,'')
		FROM events WHERE actor = ? AND`+noiseFilter+`
		ORDER BY created_at DESC LIMIT ?
	`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var e Event
		var ts string
		if err := rows.Scan(&e.ID, &ts, &e.Kind, &e.Actor, &e.ObjectType, &e.ObjectName, &e.ContainerID, &e.Image, &e.Message); err != nil {
			return nil, err
		}
		e.CreatedAt = parseDBTime(ts)
		events = append(events, e)
	}
	return events, rows.Err()
}

// ---- WatchedImage helpers ---------------------------------------------------

// WatchedImage is a container registered for automatic image update checking.
type WatchedImage struct {
	ID              int64      `json:"id"`
	ContainerID     string     `json:"container_id"`
	ContainerName   string     `json:"container_name"`
	Image           string     `json:"image"`
	CurrentDigest   string     `json:"current_digest"`
	CheckInterval   int        `json:"check_interval"`
	AutoUpdate      bool       `json:"auto_update"`
	Enabled         bool       `json:"enabled"`
	UpdateAvailable bool       `json:"update_available"`
	LastCheckedAt   *time.Time `json:"last_checked_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

const watchedCols = `id, container_id, container_name, image, COALESCE(current_digest,''),
	check_interval, auto_update, enabled, update_available, last_checked_at, created_at`

func scanWatchedImage(s scanner) (*WatchedImage, error) {
	var w WatchedImage
	var autoUpdate, enabled, updateAvailable int
	var createdAt string
	var lastCheckedPtr *string
	if err := s.Scan(&w.ID, &w.ContainerID, &w.ContainerName, &w.Image,
		&w.CurrentDigest, &w.CheckInterval, &autoUpdate, &enabled, &updateAvailable,
		&lastCheckedPtr, &createdAt); err != nil {
		return nil, err
	}
	w.AutoUpdate = autoUpdate == 1
	w.Enabled = enabled == 1
	w.UpdateAvailable = updateAvailable == 1
	// Use the multi-format parser: the SQLite driver returns DATETIME columns in
	// RFC3339-ish form, which a single hard-coded layout fails to parse (yielding
	// a zero time).
	w.CreatedAt = parseDBTime(createdAt)
	if lastCheckedPtr != nil && *lastCheckedPtr != "" {
		t := parseDBTime(*lastCheckedPtr)
		w.LastCheckedAt = &t
	}
	return &w, nil
}

// UpsertWatchedImage inserts or updates a watched image's *configuration*. On
// conflict it deliberately leaves the watcher-computed state (current_digest,
// update_available, last_checked_at) untouched so saving config from the UI
// doesn't wipe the last check result.
func (db *DB) UpsertWatchedImage(w WatchedImage) error {
	_, err := db.conn.Exec(`
		INSERT INTO watched_images (container_id, container_name, image, current_digest, check_interval, auto_update, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(container_id) DO UPDATE SET
			container_name  = excluded.container_name,
			image           = excluded.image,
			check_interval  = excluded.check_interval,
			auto_update     = excluded.auto_update,
			enabled         = excluded.enabled
	`, w.ContainerID, w.ContainerName, w.Image, w.CurrentDigest, w.CheckInterval, boolToInt(w.AutoUpdate), boolToInt(w.Enabled))
	return err
}

// UpdateWatchedImageState records the result of a check: the baseline digest the
// container is running, whether a newer image is available, and the check time.
func (db *DB) UpdateWatchedImageState(containerID, digest string, updateAvailable bool) error {
	_, err := db.conn.Exec(
		`UPDATE watched_images SET current_digest = ?, update_available = ?, last_checked_at = datetime('now') WHERE container_id = ?`,
		digest, boolToInt(updateAvailable), containerID,
	)
	return err
}

// TouchWatchedImageChecked stamps a watched image's last-checked time without
// altering its digest/update state. Used when a check is skipped or fails, so
// the per-image check_interval is honoured for those cycles too.
func (db *DB) TouchWatchedImageChecked(containerID string) error {
	_, err := db.conn.Exec(
		`UPDATE watched_images SET last_checked_at = datetime('now') WHERE container_id = ?`,
		containerID,
	)
	return err
}

// GetWatchedImage returns a single watched image by container ID, or nil if the
// container is not being watched.
func (db *DB) GetWatchedImage(containerID string) (*WatchedImage, error) {
	row := db.conn.QueryRow(`SELECT `+watchedCols+` FROM watched_images WHERE container_id = ?`, containerID)
	w, err := scanWatchedImage(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return w, err
}

// GetWatchedImages returns all watched image entries.
func (db *DB) GetWatchedImages() ([]WatchedImage, error) {
	rows, err := db.conn.Query(`SELECT ` + watchedCols + ` FROM watched_images ORDER BY container_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []WatchedImage
	for rows.Next() {
		w, err := scanWatchedImage(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *w)
	}
	return items, rows.Err()
}

// DeleteWatchedImage removes a watched image entry by container ID.
func (db *DB) DeleteWatchedImage(containerID string) error {
	_, err := db.conn.Exec(`DELETE FROM watched_images WHERE container_id = ?`, containerID)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ---- Build helpers ----------------------------------------------------------

// Build represents a Docker image build job.
type Build struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Tag         string  `json:"tag"`
	Status      string  `json:"status"`
	Progress    int     `json:"progress"`
	Step        string  `json:"step"`
	TotalSteps  int     `json:"total_steps"`
	CurrentStep int     `json:"current_step"`
	DurationMs  int     `json:"duration_ms"`
	CachePct    int     `json:"cache_pct"`
	InitiatedBy string  `json:"initiated_by"`
	Logs        string  `json:"logs,omitempty"`
	StartedAt    *string `json:"started_at,omitempty"`
	FinishedAt   *string `json:"finished_at,omitempty"`
	CreatedAt    string  `json:"created_at"`
	DefinitionID *string `json:"definition_id,omitempty"`
}

// CreateBuild inserts a new build record.
func (db *DB) CreateBuild(b *Build) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := db.conn.Exec(`
		INSERT INTO builds (id, name, tag, status, initiated_by, definition_id, started_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, b.ID, b.Name, b.Tag, b.Status, b.InitiatedBy, b.DefinitionID, now, now)
	return err
}

// UpdateBuildStatus updates build status, logs, duration and cache percentage.
func (db *DB) UpdateBuildStatus(id, status, logs string, durationMs, cachePct int) error {
	now := time.Now().UTC().Format(time.RFC3339)
	progress := 0
	if status == "succeeded" || status == "failed" || status == "cancelled" {
		progress = 100
	}
	_, err := db.conn.Exec(`
		UPDATE builds SET status=?, logs=?, duration_ms=?, cache_pct=?, progress=?, finished_at=?
		WHERE id=?
	`, status, logs, durationMs, cachePct, progress, now, id)
	return err
}

// UpdateBuildProgress updates build progress fields during a running build.
func (db *DB) UpdateBuildProgress(id string, progress int, step string, currentStep, totalSteps, durationMs int, logs string) error {
	_, err := db.conn.Exec(`
		UPDATE builds SET progress=?, step=?, current_step=?, total_steps=?, duration_ms=?, logs=?
		WHERE id=?
	`, progress, step, currentStep, totalSteps, durationMs, logs, id)
	return err
}

// GetBuild returns a build by ID.
func (db *DB) GetBuild(id string) (*Build, error) {
	row := db.conn.QueryRow(`
		SELECT id, name, tag, status, progress, step, total_steps, current_step,
		       duration_ms, cache_pct, initiated_by, logs,
		       started_at, finished_at, created_at, definition_id
		FROM builds WHERE id=?
	`, id)
	return scanBuild(row)
}

// ListBuilds returns all builds newest first.
func (db *DB) ListBuilds() ([]Build, error) {
	rows, err := db.conn.Query(`
		SELECT id, name, tag, status, progress, step, total_steps, current_step,
		       duration_ms, cache_pct, initiated_by, logs,
		       started_at, finished_at, created_at, definition_id
		FROM builds ORDER BY created_at DESC LIMIT 200
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var builds []Build
	for rows.Next() {
		b, err := scanBuild(rows)
		if err != nil {
			return nil, err
		}
		builds = append(builds, *b)
	}
	return builds, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanBuild(s scanner) (*Build, error) {
	var b Build
	var startedAt, finishedAt *string
	if err := s.Scan(&b.ID, &b.Name, &b.Tag, &b.Status, &b.Progress, &b.Step,
		&b.TotalSteps, &b.CurrentStep, &b.DurationMs, &b.CachePct, &b.InitiatedBy,
		&b.Logs, &startedAt, &finishedAt, &b.CreatedAt, &b.DefinitionID); err != nil {
		return nil, err
	}
	b.StartedAt = startedAt
	b.FinishedAt = finishedAt
	return &b, nil
}

// ---- Registry helpers -------------------------------------------------------

// Registry represents a configured Docker registry.
type Registry struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	Type        string `json:"type"`
	Username    string `json:"username"`
	ImagesCount int    `json:"images_count"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
}

// ListRegistries returns all configured registries.
func (db *DB) ListRegistries() ([]Registry, error) {
	rows, err := db.conn.Query(`
		SELECT id, name, url, type, username, images_count, status, created_at
		FROM registries ORDER BY id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var regs []Registry
	for rows.Next() {
		var r Registry
		if err := rows.Scan(&r.ID, &r.Name, &r.URL, &r.Type, &r.Username,
			&r.ImagesCount, &r.Status, &r.CreatedAt); err != nil {
			return nil, err
		}
		regs = append(regs, r)
	}
	return regs, rows.Err()
}

// UpsertRegistry inserts or updates a registry record.
func (db *DB) UpsertRegistry(r Registry) error {
	_, err := db.conn.Exec(`
		INSERT INTO registries (name, url, type, username, status)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(url) DO UPDATE SET
			name=excluded.name, type=excluded.type,
			username=excluded.username, status=excluded.status
	`, r.Name, r.URL, r.Type, r.Username, r.Status)
	return err
}

// UpdateRegistryStatus updates the live status and image count of a registry.
func (db *DB) UpdateRegistryStatus(url, status string, imagesCount int) error {
	_, err := db.conn.Exec(
		`UPDATE registries SET status=?, images_count=? WHERE url=?`,
		status, imagesCount, url,
	)
	return err
}

// DeleteRegistry removes a registry by ID.
func (db *DB) DeleteRegistry(id int64) error {
	_, err := db.conn.Exec(`DELETE FROM registries WHERE id=?`, id)
	return err
}

// ---- BuildDefinition helpers -----------------------------------------------

// BuildDefinition is a saved configuration for a repeatable Docker image build.
type BuildDefinition struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Tag            string `json:"tag"`
	SourceType     string `json:"source_type"`
	GitURL         string `json:"git_url"`
	GitBranch      string `json:"git_branch"`
	DockerfilePath string `json:"dockerfile_path"`
	Dockerfile     string `json:"dockerfile"`
	PushToRegistry bool   `json:"push_to_registry"`
	RegistryURL    string `json:"registry_url"`
	CreatedAt      string `json:"created_at"`
	// Computed from build run history.
	RunCount        int    `json:"run_count"`
	LastBuildStatus string `json:"last_build_status,omitempty"`
	LastBuiltAt     string `json:"last_built_at,omitempty"`
}

// CreateDefinition inserts a new build definition.
func (db *DB) CreateDefinition(d *BuildDefinition) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := db.conn.Exec(`
		INSERT INTO build_definitions
			(id, name, tag, source_type, git_url, git_branch, dockerfile_path, dockerfile,
			 push_to_registry, registry_url, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, d.ID, d.Name, d.Tag, d.SourceType, d.GitURL, d.GitBranch, d.DockerfilePath,
		d.Dockerfile, boolToInt(d.PushToRegistry), d.RegistryURL, now)
	return err
}

// GetDefinition returns a single build definition by ID.
func (db *DB) GetDefinition(id string) (*BuildDefinition, error) {
	row := db.conn.QueryRow(`
		SELECT id, name, tag, source_type, git_url, git_branch, dockerfile_path,
		       dockerfile, push_to_registry, registry_url, created_at
		FROM build_definitions WHERE id=?
	`, id)
	var d BuildDefinition
	var ptr int
	if err := row.Scan(&d.ID, &d.Name, &d.Tag, &d.SourceType, &d.GitURL, &d.GitBranch,
		&d.DockerfilePath, &d.Dockerfile, &ptr, &d.RegistryURL, &d.CreatedAt); err != nil {
		return nil, err
	}
	d.PushToRegistry = ptr == 1
	return &d, nil
}

// ListDefinitions returns all build definitions with computed run statistics.
func (db *DB) ListDefinitions() ([]BuildDefinition, error) {
	rows, err := db.conn.Query(`
		SELECT
			d.id, d.name, d.tag, d.source_type, d.git_url, d.git_branch,
			d.dockerfile_path, d.dockerfile, d.push_to_registry, d.registry_url, d.created_at,
			COALESCE(s.run_count, 0), COALESCE(s.last_built_at, ''), COALESCE(s.last_build_status, '')
		FROM build_definitions d
		LEFT JOIN (
			SELECT
				definition_id,
				COUNT(*) AS run_count,
				MAX(created_at) AS last_built_at,
				(SELECT status FROM builds b2
				 WHERE b2.definition_id = b1.definition_id
				 ORDER BY b2.created_at DESC LIMIT 1) AS last_build_status
			FROM builds b1
			WHERE definition_id IS NOT NULL
			GROUP BY definition_id
		) s ON s.definition_id = d.id
		ORDER BY d.created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var defs []BuildDefinition
	for rows.Next() {
		var d BuildDefinition
		var ptr int
		if err := rows.Scan(&d.ID, &d.Name, &d.Tag, &d.SourceType, &d.GitURL, &d.GitBranch,
			&d.DockerfilePath, &d.Dockerfile, &ptr, &d.RegistryURL, &d.CreatedAt,
			&d.RunCount, &d.LastBuiltAt, &d.LastBuildStatus); err != nil {
			return nil, err
		}
		d.PushToRegistry = ptr == 1
		defs = append(defs, d)
	}
	return defs, rows.Err()
}

// UpdateDefinition replaces a build definition's mutable fields.
func (db *DB) UpdateDefinition(d *BuildDefinition) error {
	_, err := db.conn.Exec(`
		UPDATE build_definitions SET
			name=?, tag=?, source_type=?, git_url=?, git_branch=?, dockerfile_path=?,
			dockerfile=?, push_to_registry=?, registry_url=?
		WHERE id=?
	`, d.Name, d.Tag, d.SourceType, d.GitURL, d.GitBranch, d.DockerfilePath,
		d.Dockerfile, boolToInt(d.PushToRegistry), d.RegistryURL, d.ID)
	return err
}

// DeleteDefinition removes a build definition by ID.
func (db *DB) DeleteDefinition(id string) error {
	_, err := db.conn.Exec(`DELETE FROM build_definitions WHERE id=?`, id)
	return err
}

// ListBuildsByDefinition returns all build runs for a specific definition.
func (db *DB) ListBuildsByDefinition(defID string) ([]Build, error) {
	rows, err := db.conn.Query(`
		SELECT id, name, tag, status, progress, step, total_steps, current_step,
		       duration_ms, cache_pct, initiated_by, logs,
		       started_at, finished_at, created_at, definition_id
		FROM builds WHERE definition_id=? ORDER BY created_at DESC LIMIT 100
	`, defID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var builds []Build
	for rows.Next() {
		b, err := scanBuild(rows)
		if err != nil {
			return nil, err
		}
		builds = append(builds, *b)
	}
	return builds, rows.Err()
}

// migrateV5 adds the repo_id FK column to the projects table.
func (db *DB) migrateV5() error {
	_, err := db.conn.Exec(`ALTER TABLE projects ADD COLUMN repo_id INTEGER`)
	if err != nil && !strings.Contains(err.Error(), "duplicate column") {
		return err
	}
	return nil
}

// migrateV6 adds the ports column to the projects table.
func (db *DB) migrateV6() error {
	_, err := db.conn.Exec(`ALTER TABLE projects ADD COLUMN ports TEXT NOT NULL DEFAULT ''`)
	if err != nil && !strings.Contains(err.Error(), "duplicate column") {
		return err
	}
	return nil
}

// migrateV7 backfills created_at / updated_at for any project rows that still
// have an empty or NULL timestamp (can happen when rows pre-date the defaults).
func (db *DB) migrateV7() error {
	db.conn.Exec(`UPDATE projects SET created_at=datetime('now') WHERE created_at IS NULL OR created_at=''`) //nolint:errcheck
	db.conn.Exec(`UPDATE projects SET updated_at=datetime('now') WHERE updated_at IS NULL OR updated_at=''`) //nolint:errcheck
	return nil
}

// migrateV8 adds actor, object_type and object_name columns to the events table.
func (db *DB) migrateV8() error {
	for _, stmt := range []string{
		`ALTER TABLE events ADD COLUMN actor       TEXT NOT NULL DEFAULT 'engine'`,
		`ALTER TABLE events ADD COLUMN object_type TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE events ADD COLUMN object_name TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.conn.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	return nil
}

// ---- GitRepo helpers --------------------------------------------------------

// GitRepo represents a git repository tracked by the application.
type GitRepo struct {
	ID          int64     `json:"id"`
	CreatedAt   time.Time `json:"created_at"`
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	RemoteURL   string    `json:"remote_url"`
	Username    string    `json:"username"`
	// Token is the decrypted credential, kept server-side only. It is never
	// serialized to API clients (json:"-") — push/pull read it directly in Go.
	// HasToken tells the UI a credential is stored without exposing it.
	Token       string    `json:"-"`
	HasToken    bool      `json:"has_token"`
	AuthorName  string    `json:"author_name"`
	AuthorEmail string    `json:"author_email"`
	Description string    `json:"description"`
}

// CreateGitRepo inserts a new git repo record and returns it with the generated ID.
func (db *DB) CreateGitRepo(r GitRepo) (*GitRepo, error) {
	res, err := db.conn.Exec(`
		INSERT INTO git_repos (name, path, remote_url, username, token, author_name, author_email, description)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, r.Name, r.Path, r.RemoteURL, r.Username, encryptSecret(r.Token), r.AuthorName, r.AuthorEmail, r.Description)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	r.ID = id
	return &r, nil
}

// GetGitRepo returns a git repo by ID.
func (db *DB) GetGitRepo(id int64) (*GitRepo, error) {
	row := db.conn.QueryRow(`
		SELECT id, created_at, name, path, remote_url, username, token, author_name, author_email, description
		FROM git_repos WHERE id=?
	`, id)
	return scanGitRepo(row)
}

// GetGitRepoByPath returns the git repo whose path matches exactly, or nil if none.
func (db *DB) GetGitRepoByPath(path string) (*GitRepo, error) {
	row := db.conn.QueryRow(`
		SELECT id, created_at, name, path, remote_url, username, token, author_name, author_email, description
		FROM git_repos WHERE path=?
	`, path)
	r, err := scanGitRepo(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return r, nil
}

// ListGitRepos returns all git repos ordered by name.
func (db *DB) ListGitRepos() ([]GitRepo, error) {
	rows, err := db.conn.Query(`
		SELECT id, created_at, name, path, remote_url, username, token, author_name, author_email, description
		FROM git_repos ORDER BY name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var repos []GitRepo
	for rows.Next() {
		r, err := scanGitRepo(rows)
		if err != nil {
			return nil, err
		}
		repos = append(repos, *r)
	}
	return repos, rows.Err()
}

// UpdateGitRepo updates mutable fields of a git repo.
func (db *DB) UpdateGitRepo(r GitRepo) error {
	_, err := db.conn.Exec(`
		UPDATE git_repos SET
			remote_url=?, username=?, token=?, author_name=?, author_email=?, description=?
		WHERE id=?
	`, r.RemoteURL, r.Username, encryptSecret(r.Token), r.AuthorName, r.AuthorEmail, r.Description, r.ID)
	return err
}

// DeleteGitRepo removes a git repo record by ID.
func (db *DB) DeleteGitRepo(id int64) error {
	_, err := db.conn.Exec(`DELETE FROM git_repos WHERE id=?`, id)
	return err
}

func scanGitRepo(s scanner) (*GitRepo, error) {
	var r GitRepo
	var ts string
	if err := s.Scan(&r.ID, &ts, &r.Name, &r.Path, &r.RemoteURL, &r.Username,
		&r.Token, &r.AuthorName, &r.AuthorEmail, &r.Description); err != nil {
		return nil, err
	}
	r.Token = decryptSecret(r.Token)
	r.HasToken = r.Token != ""
	r.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", ts)
	return &r, nil
}

// ReconcileInterruptedJobs marks builds/projects left in a non-terminal state by
// a previous crash or restart as failed, so they do not appear stuck forever.
// A build's docker child process and a project build's goroutine cannot survive a
// backend restart, so anything still "queued"/"running" (builds) or "building"
// (projects) at startup is dead. Each reset record gets an explanatory log line
// and a clean terminal shape (builds: progress=100 + finished_at) so it reads as
// a clear failure rather than a frozen-mid-progress job. Project 'running' is
// left untouched — those containers may still be up after a backend restart; only
// an interrupted in-flight 'building' is reset. Returns the total rows updated.
func (db *DB) ReconcileInterruptedJobs() (int64, error) {
	const marker = "\n[Dockyard] interrupted by a backend restart"
	var total int64
	now := time.Now().UTC().Format(time.RFC3339)

	res, err := db.conn.Exec(`
		UPDATE builds SET status='failed', progress=100, finished_at=?, logs=logs||?
		WHERE status IN ('queued','running')`, now, marker)
	if err != nil {
		return total, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		total += n
	}

	res, err = db.conn.Exec(`
		UPDATE projects SET status='failed', build_log=build_log||?, updated_at=datetime('now')
		WHERE status='building'`, marker)
	if err != nil {
		return total, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		total += n
	}
	return total, nil
}

// ---- Project helpers --------------------------------------------------------

// Project represents an uploaded local project managed by the application.
type Project struct {
	ID          int64     `json:"id"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Path        string    `json:"path"`
	Type        string    `json:"type"`        // compose | dockerfile | unknown
	Status      string    `json:"status"`      // idle | building | running | stopped | failed
	ImageTag    string    `json:"image_tag"`
	Ports       string    `json:"ports"`
	ContainerID string    `json:"container_id"`
	BuildLog    string    `json:"build_log,omitempty"`
	RunLog      string    `json:"run_log,omitempty"`
	RepoID      *int64    `json:"repo_id,omitempty"`
	// Branch is not persisted — populated at read time from git.
	Branch      string    `json:"branch"`
	// PublishedPorts is not persisted — populated at read time from the live
	// running container(s). It reflects the ports actually exposed right now,
	// which can differ from the declared Ports string after a port override.
	PublishedPorts []PortMapping `json:"published_ports,omitempty"`
}

// PortMapping is a single live host→container port binding published by a running
// container, used to show a project's real exposed ports (not just its declared
// configuration).
type PortMapping struct {
	Host      string `json:"host"`
	Container string `json:"container"`
	Protocol  string `json:"protocol,omitempty"`
}

// CreateProject inserts a new project record and returns the full row as
// stored in the DB (including auto-set status, created_at, updated_at).
func (db *DB) CreateProject(p Project) (*Project, error) {
	res, err := db.conn.Exec(`
		INSERT INTO projects (name, description, path, type, status, image_tag, ports)
		VALUES (?, ?, ?, ?, 'idle', ?, ?)
	`, p.Name, p.Description, p.Path, p.Type, p.ImageTag, p.Ports)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return db.GetProject(id)
}

// GetProject returns a project by ID.
func (db *DB) GetProject(id int64) (*Project, error) {
	row := db.conn.QueryRow(`
		SELECT id, created_at, updated_at, name, description, path, type,
		       status, image_tag, ports, container_id, build_log, run_log, repo_id
		FROM projects WHERE id=?
	`, id)
	return scanProject(row)
}

// ListProjects returns all projects ordered by name.
func (db *DB) ListProjects() ([]Project, error) {
	rows, err := db.conn.Query(`
		SELECT id, created_at, updated_at, name, description, path, type,
		       status, image_tag, ports, container_id, build_log, run_log, repo_id
		FROM projects ORDER BY name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var projects []Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, *p)
	}
	return projects, rows.Err()
}

// UpdateProjectStatus updates the status, container_id and updated_at fields.
func (db *DB) UpdateProjectStatus(id int64, status, containerID string) error {
	_, err := db.conn.Exec(`
		UPDATE projects SET status=?, container_id=?, updated_at=datetime('now') WHERE id=?
	`, status, containerID, id)
	return err
}

// UpdateProjectBuildLog appends to or replaces the build log.
func (db *DB) UpdateProjectBuildLog(id int64, log string) error {
	_, err := db.conn.Exec(`
		UPDATE projects SET build_log=?, updated_at=datetime('now') WHERE id=?
	`, log, id)
	return err
}

// UpdateProjectRunLog appends to or replaces the run log.
func (db *DB) UpdateProjectRunLog(id int64, log string) error {
	_, err := db.conn.Exec(`
		UPDATE projects SET run_log=?, updated_at=datetime('now') WHERE id=?
	`, log, id)
	return err
}

// UpdateProjectPorts updates the port-mapping string for a project.
func (db *DB) UpdateProjectPorts(id int64, ports string) error {
	_, err := db.conn.Exec(`UPDATE projects SET ports=?, updated_at=datetime('now') WHERE id=?`, ports, id)
	return err
}

// LinkProjectRepo associates a git repository with a project.
func (db *DB) LinkProjectRepo(projectID, repoID int64) error {
	_, err := db.conn.Exec(`UPDATE projects SET repo_id=?, updated_at=datetime('now') WHERE id=?`, repoID, projectID)
	return err
}

// DeleteProject removes a project record.
func (db *DB) DeleteProject(id int64) error {
	_, err := db.conn.Exec(`DELETE FROM projects WHERE id=?`, id)
	return err
}

// parseDBTime parses a SQLite datetime string trying multiple common formats.
func parseDBTime(s string) time.Time {
	for _, f := range []string{
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05",
		time.RFC3339,
		time.RFC3339Nano,
	} {
		if t, err := time.Parse(f, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

func scanProject(s scanner) (*Project, error) {
	var p Project
	var createdAt, updatedAt string
	var repoID sql.NullInt64
	if err := s.Scan(&p.ID, &createdAt, &updatedAt, &p.Name, &p.Description, &p.Path,
		&p.Type, &p.Status, &p.ImageTag, &p.Ports, &p.ContainerID, &p.BuildLog, &p.RunLog, &repoID); err != nil {
		return nil, err
	}
	p.CreatedAt = parseDBTime(createdAt)
	p.UpdatedAt = parseDBTime(updatedAt)
	if repoID.Valid {
		p.RepoID = &repoID.Int64
	}
	return &p, nil
}

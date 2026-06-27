package storage

import (
	"strings"
	"time"
)

// Diagnostics ("Dockyard Insights") store: an in-house, SQLite-backed error/event
// tracker. diag_events holds individual (sampled) occurrences; diag_groups is a
// fingerprint rollup (Sentry-style) so the UI groups occurrences instead of
// showing a flat firehose. Writes are accumulated + batched by the handler-side
// sink, never written synchronously from the request path.

// DiagEvent is one captured occurrence (a backend 5xx/panic or a frontend error).
type DiagEvent struct {
	ID          int64     `json:"id"`
	TS          time.Time `json:"ts"`
	Level       string    `json:"level"`  // info | warn | error
	Source      string    `json:"source"` // backend | frontend
	Component   string    `json:"component"`
	Message     string    `json:"message"`
	Fingerprint string    `json:"fingerprint"`
	RequestID   string    `json:"request_id"`
	Actor       string    `json:"actor"`
	Route       string    `json:"route"`
	StatusCode  int       `json:"status_code"`
	Stack       string    `json:"stack,omitempty"`
	Context     string    `json:"context,omitempty"` // JSON blob
	Release     string    `json:"release"`
	UserAgent   string    `json:"user_agent,omitempty"`
}

// DiagGroup is the fingerprint rollup shown in the issue feed.
type DiagGroup struct {
	Fingerprint string    `json:"fingerprint"`
	Title       string    `json:"title"`
	Level       string    `json:"level"`
	Source      string    `json:"source"`
	FirstSeen   time.Time `json:"first_seen"`
	LastSeen    time.Time `json:"last_seen"`
	Count       int       `json:"count"`
	Status      string    `json:"status"` // open | resolved | muted
}

// DiagAccum is a batch entry: a sample occurrence + how many occurrences it
// represents since the last flush (so a render loop can't write a row per event).
type DiagAccum struct {
	Sample DiagEvent
	Count  int
}

// DiagStats is the headline rollup for the Insights dashboard.
type DiagStats struct {
	OpenGroups  int            `json:"open_groups"`
	Events24h   int            `json:"events_24h"`
	ByLevel     map[string]int `json:"by_level"`
	BySource    map[string]int `json:"by_source"`
}

// migrateV27 creates the diagnostics tables.
func (db *DB) migrateV27() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS diag_groups (
			fingerprint TEXT PRIMARY KEY,
			title       TEXT NOT NULL,
			level       TEXT NOT NULL,
			source      TEXT NOT NULL,
			first_seen  DATETIME NOT NULL,
			last_seen   DATETIME NOT NULL,
			count       INTEGER NOT NULL DEFAULT 0,
			status      TEXT NOT NULL DEFAULT 'open'
		);
		CREATE INDEX IF NOT EXISTS idx_diag_groups_lastseen ON diag_groups(last_seen);
		CREATE INDEX IF NOT EXISTS idx_diag_groups_status   ON diag_groups(status);

		CREATE TABLE IF NOT EXISTS diag_events (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			ts          DATETIME NOT NULL,
			level       TEXT NOT NULL,
			source      TEXT NOT NULL,
			component   TEXT NOT NULL DEFAULT '',
			message     TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			request_id  TEXT NOT NULL DEFAULT '',
			actor       TEXT NOT NULL DEFAULT '',
			route       TEXT NOT NULL DEFAULT '',
			status_code INTEGER NOT NULL DEFAULT 0,
			stack       TEXT NOT NULL DEFAULT '',
			context     TEXT NOT NULL DEFAULT '',
			release     TEXT NOT NULL DEFAULT '',
			user_agent  TEXT NOT NULL DEFAULT ''
		);
		CREATE INDEX IF NOT EXISTS idx_diag_events_fp ON diag_events(fingerprint, ts);
		CREATE INDEX IF NOT EXISTS idx_diag_events_ts ON diag_events(ts);
	`)
	return err
}

func diagTitle(msg string) string {
	msg = strings.TrimSpace(strings.SplitN(msg, "\n", 2)[0])
	if len(msg) > 160 {
		msg = msg[:160] + "…"
	}
	if msg == "" {
		msg = "(no message)"
	}
	return msg
}

// InsertDiagBatch upserts each fingerprint's group (bumping count + last_seen) and
// inserts ONE sample event per fingerprint, all in a single transaction. Called
// by the sink on its flush tick, so DB writes are bounded by distinct-fingerprint
// count per interval regardless of event rate.
func (db *DB) InsertDiagBatch(batch []DiagAccum) error {
	if len(batch) == 0 {
		return nil
	}
	tx, err := db.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	for _, a := range batch {
		e := a.Sample
		ts := e.TS.UTC().Format("2006-01-02 15:04:05.000")
		if _, err := tx.Exec(`
			INSERT INTO diag_groups (fingerprint, title, level, source, first_seen, last_seen, count, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
			ON CONFLICT(fingerprint) DO UPDATE SET
				last_seen = excluded.last_seen,
				count     = count + excluded.count,
				level     = excluded.level,
				title     = excluded.title
		`, e.Fingerprint, diagTitle(e.Message), e.Level, e.Source, ts, ts, a.Count); err != nil {
			return err
		}
		if _, err := tx.Exec(`
			INSERT INTO diag_events
				(ts, level, source, component, message, fingerprint, request_id, actor, route, status_code, stack, context, release, user_agent)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, ts, e.Level, e.Source, e.Component, e.Message, e.Fingerprint, e.RequestID, e.Actor,
			e.Route, e.StatusCode, e.Stack, e.Context, e.Release, e.UserAgent); err != nil {
			return err
		}
	}
	return tx.Commit()
}

const diagGroupCols = `fingerprint, title, level, source, first_seen, last_seen, count, status`

func scanDiagGroup(s scanner) (*DiagGroup, error) {
	var g DiagGroup
	var first, last string
	if err := s.Scan(&g.Fingerprint, &g.Title, &g.Level, &g.Source, &first, &last, &g.Count, &g.Status); err != nil {
		return nil, err
	}
	g.FirstSeen = parseDBTime(first)
	g.LastSeen = parseDBTime(last)
	return &g, nil
}

// QueryGroups returns issue rollups, newest activity first. status "" returns all;
// source "" returns all.
func (db *DB) QueryGroups(status, source string, limit int) ([]DiagGroup, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT ` + diagGroupCols + ` FROM diag_groups WHERE 1=1`
	args := []any{}
	if status != "" {
		q += ` AND status = ?`
		args = append(args, status)
	}
	if source != "" {
		q += ` AND source = ?`
		args = append(args, source)
	}
	q += ` ORDER BY last_seen DESC LIMIT ?`
	args = append(args, limit)
	rows, err := db.read.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DiagGroup
	for rows.Next() {
		g, err := scanDiagGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *g)
	}
	return out, rows.Err()
}

const diagEventCols = `id, ts, level, source, component, message, fingerprint, request_id, actor, route, status_code, stack, context, release, user_agent`

func scanDiagEvent(s scanner) (*DiagEvent, error) {
	var e DiagEvent
	var ts string
	if err := s.Scan(&e.ID, &ts, &e.Level, &e.Source, &e.Component, &e.Message, &e.Fingerprint,
		&e.RequestID, &e.Actor, &e.Route, &e.StatusCode, &e.Stack, &e.Context, &e.Release, &e.UserAgent); err != nil {
		return nil, err
	}
	e.TS = parseDBTime(ts)
	return &e, nil
}

// QueryEvents returns recent occurrences, optionally for one fingerprint.
func (db *DB) QueryEvents(fingerprint string, limit int) ([]DiagEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT ` + diagEventCols + ` FROM diag_events`
	args := []any{}
	if fingerprint != "" {
		q += ` WHERE fingerprint = ?`
		args = append(args, fingerprint)
	}
	q += ` ORDER BY ts DESC, id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := db.read.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DiagEvent
	for rows.Next() {
		e, err := scanDiagEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// SetDiagGroupStatus marks a group open|resolved|muted. Returns sql.ErrNoRows-free
// success even if the fingerprint is unknown (idempotent).
func (db *DB) SetDiagGroupStatus(fingerprint, status string) error {
	_, err := db.conn.Exec(`UPDATE diag_groups SET status=? WHERE fingerprint=?`, status, fingerprint)
	return err
}

// DiagStatsSummary returns the dashboard headline numbers.
func (db *DB) DiagStatsSummary() (*DiagStats, error) {
	s := &DiagStats{ByLevel: map[string]int{}, BySource: map[string]int{}}
	if err := db.read.QueryRow(`SELECT COUNT(*) FROM diag_groups WHERE status='open'`).Scan(&s.OpenGroups); err != nil {
		return nil, err
	}
	cutoff := time.Now().UTC().Add(-24 * time.Hour).Format("2006-01-02 15:04:05.000")
	if err := db.read.QueryRow(`SELECT COUNT(*) FROM diag_events WHERE ts >= ?`, cutoff).Scan(&s.Events24h); err != nil {
		return nil, err
	}
	collect := func(q string, into map[string]int) error {
		rows, err := db.read.Query(q, cutoff)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k string
			var n int
			if err := rows.Scan(&k, &n); err != nil {
				return err
			}
			into[k] = n
		}
		return rows.Err()
	}
	if err := collect(`SELECT level, COUNT(*) FROM diag_events WHERE ts >= ? GROUP BY level`, s.ByLevel); err != nil {
		return nil, err
	}
	if err := collect(`SELECT source, COUNT(*) FROM diag_events WHERE ts >= ? GROUP BY source`, s.BySource); err != nil {
		return nil, err
	}
	return s, nil
}

// PruneDiag deletes events + idle groups older than the retention window.
func (db *DB) PruneDiag(retentionDays int) error {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -retentionDays).Format("2006-01-02 15:04:05.000")
	if _, err := db.conn.Exec(`DELETE FROM diag_events WHERE ts < ?`, cutoff); err != nil {
		return err
	}
	_, err := db.conn.Exec(`DELETE FROM diag_groups WHERE last_seen < ?`, cutoff)
	return err
}

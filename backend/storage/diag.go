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
	Component   string    `json:"component"` // route/component of the most-recent occurrence
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
	OpenGroups    int               `json:"open_groups"`
	Events24h     int               `json:"events_24h"`
	EventsPrev24h int               `json:"events_prev_24h"` // the 24h before that, for a trend delta
	ByLevel       map[string]int    `json:"by_level"`
	BySource      map[string]int    `json:"by_source"`
	Series        []DiagBucketPoint `json:"series"` // hourly, last 24h, for the sparkline
}

// DiagBucketPoint is one hour of the events-over-time series (true counts).
type DiagBucketPoint struct {
	Bucket string `json:"bucket"` // hour, UTC "2006-01-02 15:00:00"
	Total  int    `json:"total"`
	Errors int    `json:"errors"`
	Warns  int    `json:"warns"`
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

// migrateV28 adds the rolled-up component (route/file of the latest occurrence)
// to diag_groups so the issue feed can show it.
func (db *DB) migrateV28() error {
	_, err := db.conn.Exec(`ALTER TABLE diag_groups ADD COLUMN component TEXT NOT NULL DEFAULT ''`)
	if err != nil && !strings.Contains(err.Error(), "duplicate column") {
		return err
	}
	return nil
}

// migrateV29 creates the hourly event counter. Unlike diag_events (which stores
// one SAMPLED occurrence per fingerprint per flush), these buckets accumulate the
// TRUE occurrence count, so the 24h totals + the events-over-time trend are exact.
func (db *DB) migrateV29() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS diag_buckets (
			bucket TEXT    NOT NULL,            -- hour, "2006-01-02 15:00:00" UTC
			level  TEXT    NOT NULL,            -- info | warn | error
			source TEXT    NOT NULL,            -- backend | frontend
			count  INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (bucket, level, source)
		);
		CREATE INDEX IF NOT EXISTS idx_diag_buckets_bucket ON diag_buckets(bucket);
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
			INSERT INTO diag_groups (fingerprint, title, level, source, component, first_seen, last_seen, count, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
			ON CONFLICT(fingerprint) DO UPDATE SET
				last_seen = excluded.last_seen,
				count     = count + excluded.count,
				level     = excluded.level,
				title     = excluded.title,
				component = excluded.component,
				-- A recurrence REOPENS a resolved issue (regression) so it doesn't
				-- silently pile up while the feed shows "all clear"; a deliberate
				-- mute is respected.
				status    = CASE WHEN status = 'resolved' THEN 'open' ELSE status END
		`, e.Fingerprint, diagTitle(e.Message), e.Level, e.Source, e.Component, ts, ts, a.Count); err != nil {
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
		// Accumulate the TRUE occurrence count into the hour bucket (a.Count, not 1)
		// — this is what makes the 24h totals + trend exact despite event sampling.
		hour := e.TS.UTC().Truncate(time.Hour).Format("2006-01-02 15:00:00")
		if _, err := tx.Exec(`
			INSERT INTO diag_buckets (bucket, level, source, count) VALUES (?, ?, ?, ?)
			ON CONFLICT(bucket, level, source) DO UPDATE SET count = count + excluded.count
		`, hour, e.Level, e.Source, a.Count); err != nil {
			return err
		}
	}
	return tx.Commit()
}

const diagGroupCols = `fingerprint, title, level, source, component, first_seen, last_seen, count, status`

func scanDiagGroup(s scanner) (*DiagGroup, error) {
	var g DiagGroup
	var first, last string
	if err := s.Scan(&g.Fingerprint, &g.Title, &g.Level, &g.Source, &g.Component, &first, &last, &g.Count, &g.Status); err != nil {
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

// DiagStatsSummary returns the dashboard headline numbers from the TRUE hourly
// counters (not the sampled diag_events rows), so the totals + trend are exact.
func (db *DB) DiagStatsSummary() (*DiagStats, error) {
	s := &DiagStats{ByLevel: map[string]int{}, BySource: map[string]int{}}
	if err := db.read.QueryRow(`SELECT COUNT(*) FROM diag_groups WHERE status='open'`).Scan(&s.OpenGroups); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	hour := func(t time.Time) string { return t.Truncate(time.Hour).Format("2006-01-02 15:00:00") }
	cut24 := hour(now.Add(-24 * time.Hour))
	cut48 := hour(now.Add(-48 * time.Hour))

	if err := db.read.QueryRow(`SELECT COALESCE(SUM(count),0) FROM diag_buckets WHERE bucket >= ?`, cut24).Scan(&s.Events24h); err != nil {
		return nil, err
	}
	if err := db.read.QueryRow(`SELECT COALESCE(SUM(count),0) FROM diag_buckets WHERE bucket >= ? AND bucket < ?`, cut48, cut24).Scan(&s.EventsPrev24h); err != nil {
		return nil, err
	}
	collect := func(col string, into map[string]int) error {
		rows, err := db.read.Query(`SELECT `+col+`, SUM(count) FROM diag_buckets WHERE bucket >= ? GROUP BY `+col, cut24)
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
	if err := collect("level", s.ByLevel); err != nil {
		return nil, err
	}
	if err := collect("source", s.BySource); err != nil {
		return nil, err
	}

	// Hourly events-over-time series (last 24h) for the sparkline.
	rows, err := db.read.Query(`
		SELECT bucket, SUM(count),
		       SUM(CASE WHEN level='error' THEN count ELSE 0 END),
		       SUM(CASE WHEN level='warn'  THEN count ELSE 0 END)
		FROM diag_buckets WHERE bucket >= ? GROUP BY bucket ORDER BY bucket`, cut24)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p DiagBucketPoint
		if err := rows.Scan(&p.Bucket, &p.Total, &p.Errors, &p.Warns); err != nil {
			return nil, err
		}
		s.Series = append(s.Series, p)
	}
	return s, rows.Err()
}

// CountNewIssuesSince returns how many OPEN issues first appeared since the given
// time, plus the title of the most recent — the basis for the new_issue alert.
func (db *DB) CountNewIssuesSince(since time.Time) (int, string, error) {
	cutoff := since.UTC().Format("2006-01-02 15:04:05.000")
	var n int
	if err := db.read.QueryRow(`SELECT COUNT(*) FROM diag_groups WHERE status='open' AND first_seen >= ?`, cutoff).Scan(&n); err != nil {
		return 0, "", err
	}
	var title string
	if n > 0 {
		_ = db.read.QueryRow(`SELECT title FROM diag_groups WHERE status='open' AND first_seen >= ? ORDER BY first_seen DESC LIMIT 1`, cutoff).Scan(&title)
	}
	return n, title, nil
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
	if _, err := db.conn.Exec(`DELETE FROM diag_buckets WHERE bucket < ?`, cutoff); err != nil {
		return err
	}
	_, err := db.conn.Exec(`DELETE FROM diag_groups WHERE last_seen < ?`, cutoff)
	return err
}

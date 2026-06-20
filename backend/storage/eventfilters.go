package storage

import (
	"errors"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Global event mute rules
//
// The events/audit feed can be flooded by chatty containers (a watchtower that
// starts/exits constantly, health probes, etc.). An EventFilter is a global mute
// rule: an event is hidden when it matches an enabled rule. Rules are applied at
// read time, so nothing is lost — muted events are still recorded and can be
// revealed again by disabling/removing the rule or toggling "show muted".
// ─────────────────────────────────────────────────────────────────────────────

// EventFilter is a single mute rule. An event matches when its object name
// contains ObjectName (case-insensitive substring, when set) AND its kind equals
// Kind (when set). At least one of the two is always set, so a rule can never
// match — and therefore mute — every event.
type EventFilter struct {
	ID         int64     `json:"id"`
	ObjectName string    `json:"object_name"`
	Kind       string    `json:"kind"`
	Enabled    bool      `json:"enabled"`
	CreatedAt  time.Time `json:"created_at"`
}

// ErrEmptyEventFilter is returned when a rule would set neither a name pattern nor
// a kind — which would mute everything.
var ErrEmptyEventFilter = errors.New("a filter must set a name pattern, a kind, or both")

// migrateV24 creates the global event-mute-rules table.
func (db *DB) migrateV24() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS event_filters (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			object_name TEXT NOT NULL DEFAULT '',
			kind        TEXT NOT NULL DEFAULT '',
			enabled     INTEGER NOT NULL DEFAULT 1,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		);
	`)
	return err
}

// ListEventFilters returns every mute rule, newest first.
func (db *DB) ListEventFilters() ([]EventFilter, error) {
	rows, err := db.conn.Query(
		`SELECT id, object_name, kind, enabled, created_at FROM event_filters ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EventFilter
	for rows.Next() {
		f, err := scanEventFilter(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// EnabledEventFilters returns only the active rules — what actually mutes the feed.
func (db *DB) EnabledEventFilters() ([]EventFilter, error) {
	all, err := db.ListEventFilters()
	if err != nil {
		return nil, err
	}
	on := all[:0:0]
	for _, f := range all {
		if f.Enabled {
			on = append(on, f)
		}
	}
	return on, nil
}

// GetEventFilter returns a single rule by id.
func (db *DB) GetEventFilter(id int64) (*EventFilter, error) {
	row := db.conn.QueryRow(
		`SELECT id, object_name, kind, enabled, created_at FROM event_filters WHERE id=?`, id)
	f, err := scanEventFilter(row)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// CreateEventFilter inserts a mute rule and returns the stored row. ObjectName is
// matched case-insensitively as a substring; Kind is matched exactly. Returns
// ErrEmptyEventFilter when both are blank.
func (db *DB) CreateEventFilter(objectName, kind string) (*EventFilter, error) {
	objectName = strings.TrimSpace(objectName)
	kind = strings.TrimSpace(kind)
	if objectName == "" && kind == "" {
		return nil, ErrEmptyEventFilter
	}
	res, err := db.conn.Exec(
		`INSERT INTO event_filters (object_name, kind, enabled) VALUES (?, ?, 1)`, objectName, kind)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return db.GetEventFilter(id)
}

// SetEventFilterEnabled toggles a rule on or off without deleting it.
func (db *DB) SetEventFilterEnabled(id int64, enabled bool) error {
	_, err := db.conn.Exec(`UPDATE event_filters SET enabled=? WHERE id=?`, boolToInt(enabled), id)
	return err
}

// DeleteEventFilter removes a rule.
func (db *DB) DeleteEventFilter(id int64) error {
	_, err := db.conn.Exec(`DELETE FROM event_filters WHERE id=?`, id)
	return err
}

// scanEventFilter reads one row from either a *sql.Row or *sql.Rows.
func scanEventFilter(s interface{ Scan(...any) error }) (EventFilter, error) {
	var f EventFilter
	var enabled int
	var ts string
	if err := s.Scan(&f.ID, &f.ObjectName, &f.Kind, &enabled, &ts); err != nil {
		return EventFilter{}, err
	}
	f.Enabled = enabled != 0
	f.CreatedAt = parseDBTime(ts)
	return f, nil
}

// Matches reports whether the rule mutes event e.
func (f EventFilter) Matches(e Event) bool {
	if f.ObjectName != "" && !strings.Contains(strings.ToLower(e.ObjectName), strings.ToLower(f.ObjectName)) {
		return false
	}
	if f.Kind != "" && e.Kind != f.Kind {
		return false
	}
	return true
}

// EventMuted reports whether any enabled rule mutes the event.
func EventMuted(e Event, rules []EventFilter) bool {
	for _, f := range rules {
		if f.Enabled && f.Matches(e) {
			return true
		}
	}
	return false
}

// muteExclusionSQL builds a SQL boolean fragment (plus its args) that is true for
// any event matched by an enabled rule. Returns ("", nil) when no active rule
// exists. Used to mute events at the database layer so the result window stays
// filled with signal rather than noise that is then dropped client-side.
func muteExclusionSQL(rules []EventFilter) (string, []any) {
	var clauses []string
	var args []any
	for _, f := range rules {
		if !f.Enabled {
			continue
		}
		var parts []string
		if f.ObjectName != "" {
			parts = append(parts, `object_name LIKE ? ESCAPE '\'`)
			args = append(args, "%"+likeEscape(f.ObjectName)+"%")
		}
		if f.Kind != "" {
			parts = append(parts, `kind = ?`)
			args = append(args, f.Kind)
		}
		if len(parts) == 0 {
			continue
		}
		clauses = append(clauses, "("+strings.Join(parts, " AND ")+")")
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return "(" + strings.Join(clauses, " OR ") + ")", args
}

// likeEscape escapes the LIKE metacharacters so a literal substring (e.g. a
// container name containing "_") is matched literally, paired with ESCAPE '\'.
func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

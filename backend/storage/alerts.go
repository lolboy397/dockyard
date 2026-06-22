package storage

import (
	"strings"
	"time"
)

// AlertRule is a user-defined condition that fires a notification.
type AlertRule struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	Type       string    `json:"type"`        // host_cpu | host_mem | host_disk | container_exited
	Threshold  float64   `json:"threshold"`   // percent for host_* rules
	Channel    string    `json:"channel"`     // in_app | webhook
	WebhookURL string    `json:"webhook_url"`
	Enabled    bool      `json:"enabled"`
	ForSeconds int       `json:"for_seconds"` // condition must hold this long before firing (0 = immediate)
	Firing     bool      `json:"firing"`      // runtime: currently in a fired (unresolved) state

	// PendingSince is runtime state: when the condition first went active in the
	// current episode (used to honour ForSeconds). Zero when idle. Persisted so a
	// restart neither re-fires active alerts nor restarts the "for" timer.
	PendingSince time.Time `json:"-"`

	CreatedAt time.Time `json:"created_at"`
}

// alertCols is the canonical column list, shared by every SELECT so the scan
// order stays in lockstep with scanAlertRule.
const alertCols = `id, name, type, threshold, channel, webhook_url, enabled, for_seconds, firing, pending_since, created_at`

// migrateV12 creates the alert rules table.
func (db *DB) migrateV12() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS alert_rules (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			name        TEXT NOT NULL,
			type        TEXT NOT NULL,
			threshold   REAL NOT NULL DEFAULT 0,
			channel     TEXT NOT NULL DEFAULT 'in_app',
			webhook_url TEXT NOT NULL DEFAULT '',
			enabled     INTEGER NOT NULL DEFAULT 1,
			created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		);
	`)
	return err
}

// migrateV17 adds the "for" duration and persisted firing state to alert_rules,
// so transient spikes don't fire instantly and a restart doesn't re-notify
// every currently-active alert.
func (db *DB) migrateV17() error {
	for _, stmt := range []string{
		`ALTER TABLE alert_rules ADD COLUMN for_seconds   INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE alert_rules ADD COLUMN firing        INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE alert_rules ADD COLUMN pending_since TEXT    NOT NULL DEFAULT ''`,
	} {
		if _, err := db.conn.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	return nil
}

func scanAlertRule(s scanner) (*AlertRule, error) {
	var a AlertRule
	var enabled, firing int
	var pendingSince, ts string
	if err := s.Scan(&a.ID, &a.Name, &a.Type, &a.Threshold, &a.Channel, &a.WebhookURL,
		&enabled, &a.ForSeconds, &firing, &pendingSince, &ts); err != nil {
		return nil, err
	}
	a.Enabled = enabled == 1
	a.Firing = firing == 1
	if pendingSince != "" {
		a.PendingSince = parseDBTime(pendingSince)
	}
	a.CreatedAt = parseDBTime(ts)
	return &a, nil
}

// ListAlertRules returns all alert rules.
func (db *DB) ListAlertRules() ([]AlertRule, error) {
	rows, err := db.read.Query(`SELECT ` + alertCols + ` FROM alert_rules ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AlertRule
	for rows.Next() {
		a, err := scanAlertRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// CreateAlertRule inserts a rule and returns the stored row.
func (db *DB) CreateAlertRule(a AlertRule) (*AlertRule, error) {
	res, err := db.conn.Exec(
		`INSERT INTO alert_rules (name, type, threshold, channel, webhook_url, enabled, for_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		a.Name, a.Type, a.Threshold, defaultStr(a.Channel, "in_app"), a.WebhookURL, boolToInt(a.Enabled), a.ForSeconds,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	row := db.read.QueryRow(`SELECT `+alertCols+` FROM alert_rules WHERE id=?`, id)
	return scanAlertRule(row)
}

// UpdateAlertRule updates a rule's user-editable fields. Reconfiguring a rule
// clears its firing/pending state so the next evaluation starts a fresh episode.
func (db *DB) UpdateAlertRule(a AlertRule) error {
	_, err := db.conn.Exec(
		`UPDATE alert_rules SET name=?, type=?, threshold=?, channel=?, webhook_url=?, enabled=?, for_seconds=?,
		        firing=0, pending_since='' WHERE id=?`,
		a.Name, a.Type, a.Threshold, defaultStr(a.Channel, "in_app"), a.WebhookURL, boolToInt(a.Enabled), a.ForSeconds, a.ID,
	)
	return err
}

// SetAlertState persists an alert's runtime firing/pending state. pendingSince
// is stored as RFC3339; a zero time clears it.
func (db *DB) SetAlertState(id int64, firing bool, pendingSince time.Time) error {
	ps := ""
	if !pendingSince.IsZero() {
		ps = pendingSince.UTC().Format(time.RFC3339)
	}
	_, err := db.conn.Exec(`UPDATE alert_rules SET firing=?, pending_since=? WHERE id=?`, boolToInt(firing), ps, id)
	return err
}

// DeleteAlertRule removes a rule by id.
func (db *DB) DeleteAlertRule(id int64) error {
	_, err := db.conn.Exec(`DELETE FROM alert_rules WHERE id=?`, id)
	return err
}

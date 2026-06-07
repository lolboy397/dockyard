package storage

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
)

// migrateV15 creates the per-stack deploy-webhook token table.
func (db *DB) migrateV15() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS stack_webhooks (
			stack_name TEXT PRIMARY KEY,
			token      TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT (datetime('now'))
		);
	`)
	return err
}

// EnsureStackWebhook returns the stack's webhook token, generating one on first
// request.
func (db *DB) EnsureStackWebhook(name string) (string, error) {
	var token string
	if err := db.conn.QueryRow(`SELECT token FROM stack_webhooks WHERE stack_name=?`, name).Scan(&token); err == nil && token != "" {
		return token, nil
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	if _, err := db.conn.Exec(`INSERT OR REPLACE INTO stack_webhooks (stack_name, token) VALUES (?, ?)`, name, token); err != nil {
		return "", err
	}
	return token, nil
}

// ValidateStackWebhook reports whether token matches the stack's webhook token
// (constant-time).
func (db *DB) ValidateStackWebhook(name, token string) bool {
	var stored string
	if err := db.conn.QueryRow(`SELECT token FROM stack_webhooks WHERE stack_name=?`, name).Scan(&stored); err != nil {
		return false
	}
	return stored != "" && subtle.ConstantTimeCompare([]byte(stored), []byte(token)) == 1
}

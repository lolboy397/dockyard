package storage

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
)

// migrateV16 creates the per-project deploy-on-push table.
func (db *DB) migrateV16() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS project_deploy (
			project_id INTEGER PRIMARY KEY,
			token      TEXT NOT NULL,
			enabled    INTEGER NOT NULL DEFAULT 1
		);
	`)
	return err
}

// EnableProjectDeploy turns on deploy-on-push for a project and returns its
// webhook token (stable across re-enables).
func (db *DB) EnableProjectDeploy(projectID int64) (string, error) {
	var token string
	if err := db.read.QueryRow(`SELECT token FROM project_deploy WHERE project_id=?`, projectID).Scan(&token); err != nil || token == "" {
		b := make([]byte, 24)
		if _, e := rand.Read(b); e != nil {
			return "", e
		}
		token = base64.RawURLEncoding.EncodeToString(b)
	}
	if _, err := db.conn.Exec(
		`INSERT INTO project_deploy (project_id, token, enabled) VALUES (?, ?, 1)
		 ON CONFLICT(project_id) DO UPDATE SET token=excluded.token, enabled=1`,
		projectID, token,
	); err != nil {
		return "", err
	}
	return token, nil
}

// DisableProjectDeploy turns off deploy-on-push.
func (db *DB) DisableProjectDeploy(projectID int64) error {
	_, err := db.conn.Exec(`UPDATE project_deploy SET enabled=0 WHERE project_id=?`, projectID)
	return err
}

// GetProjectDeploy returns (enabled, token, found).
func (db *DB) GetProjectDeploy(projectID int64) (bool, string, bool) {
	var token string
	var enabled int
	if err := db.read.QueryRow(`SELECT enabled, token FROM project_deploy WHERE project_id=?`, projectID).Scan(&enabled, &token); err != nil {
		if err == sql.ErrNoRows {
			return false, "", false
		}
		return false, "", false
	}
	return enabled == 1, token, true
}

// ValidateProjectDeploy reports whether the token matches and deploy is enabled.
func (db *DB) ValidateProjectDeploy(projectID int64, token string) bool {
	enabled, stored, found := db.GetProjectDeploy(projectID)
	return found && enabled && stored != "" && subtle.ConstantTimeCompare([]byte(stored), []byte(token)) == 1
}

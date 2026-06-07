package storage

import (
	"database/sql"
	"errors"
	"time"
)

// ---- Auth / first-run setup schema ------------------------------------------

// migrateV9 creates the authentication & instance-configuration tables that
// back the first-run setup wizard and the login screen.
func (db *DB) migrateV9() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at    DATETIME NOT NULL DEFAULT (datetime('now')),
			full_name     TEXT NOT NULL DEFAULT '',
			email         TEXT NOT NULL DEFAULT '',
			username      TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role          TEXT NOT NULL DEFAULT 'admin'
		);

		CREATE TABLE IF NOT EXISTS instance_config (
			id             INTEGER PRIMARY KEY CHECK (id = 1),
			instance_name  TEXT NOT NULL DEFAULT 'production',
			docker_host    TEXT NOT NULL DEFAULT '/var/run/docker.sock',
			data_dir       TEXT NOT NULL DEFAULT '/var/lib/dockyard',
			bind_addr      TEXT NOT NULL DEFAULT '0.0.0.0:9443',
			tls            INTEGER NOT NULL DEFAULT 1,
			auto_update    INTEGER NOT NULL DEFAULT 1,
			telemetry      INTEGER NOT NULL DEFAULT 0,
			registry       TEXT NOT NULL DEFAULT 'docker.io',
			setup_complete INTEGER NOT NULL DEFAULT 0,
			created_at     DATETIME NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS sessions (
			token      TEXT PRIMARY KEY,
			user_id    INTEGER NOT NULL,
			created_at DATETIME NOT NULL DEFAULT (datetime('now')),
			expires_at DATETIME NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
	`)
	return err
}

// ---- User -------------------------------------------------------------------

// User is an account that can sign in to the instance.
type User struct {
	ID           int64      `json:"id"`
	CreatedAt    time.Time  `json:"created_at"`
	FullName     string     `json:"full_name"`
	Email        string     `json:"email"`
	Username     string     `json:"username"`
	Role         string     `json:"role"`
	Active       bool       `json:"active"`
	Status       string     `json:"status"`             // active | invited | suspended
	TwoFactor    bool       `json:"two_factor_enabled"` // 2FA required/enabled
	AuthMethod   string     `json:"auth_method"`        // password | SSO · … | invite pending
	LastActiveAt *time.Time `json:"last_active_at,omitempty"`
	PasswordHash string     `json:"-"`
	// Tier is the authorization level (admin|operator|viewer) derived from the
	// user's role. Populated by GetSessionUser for request authorization; not
	// stored on the user row and not serialized.
	Tier string `json:"-"`
}

// userCols is the canonical column list (and order) every user scan reads.
const userCols = `id, created_at, full_name, email, username, password_hash, role, active,
	COALESCE(status,'active'), COALESCE(two_factor_enabled,0),
	COALESCE(auth_method,'password'), last_active_at`

// CountUsers returns the number of accounts in the system.
func (db *DB) CountUsers() (int, error) {
	var n int
	err := db.conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser inserts a new account and returns the stored row. Status, auth
// method and the active flag are kept consistent (active ⇔ status == active).
func (db *DB) CreateUser(u User) (*User, error) {
	status := defaultStr(u.Status, "active")
	authMethod := defaultStr(u.AuthMethod, "password")
	res, err := db.conn.Exec(`
		INSERT INTO users (full_name, email, username, password_hash, role, active, status, two_factor_enabled, auth_method)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, u.FullName, u.Email, u.Username, u.PasswordHash, defaultStr(u.Role, "admin"),
		boolToInt(status == "active"), status, boolToInt(u.TwoFactor), authMethod)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return db.GetUserByID(id)
}

// GetUserByID returns a user by primary key.
func (db *DB) GetUserByID(id int64) (*User, error) {
	row := db.conn.QueryRow(`SELECT `+userCols+` FROM users WHERE id=?`, id)
	return scanUser(row)
}

// GetUserByUsername returns a user by username, or nil if not found.
func (db *DB) GetUserByUsername(username string) (*User, error) {
	row := db.conn.QueryRow(`SELECT `+userCols+` FROM users WHERE username=?`, username)
	u, err := scanUser(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return u, nil
}

func scanUser(s scanner) (*User, error) {
	var u User
	var ts string
	var active, twofa int
	var lastActive sql.NullString
	if err := s.Scan(&u.ID, &ts, &u.FullName, &u.Email, &u.Username, &u.PasswordHash,
		&u.Role, &active, &u.Status, &twofa, &u.AuthMethod, &lastActive); err != nil {
		return nil, err
	}
	u.Active = active == 1
	u.TwoFactor = twofa == 1
	u.CreatedAt = parseDBTime(ts)
	if lastActive.Valid && lastActive.String != "" {
		t := parseDBTime(lastActive.String)
		if !t.IsZero() {
			u.LastActiveAt = &t
		}
	}
	return &u, nil
}

// ---- Instance config --------------------------------------------------------

// InstanceConfig holds the instance-wide settings captured during setup.
type InstanceConfig struct {
	InstanceName  string `json:"instance_name"`
	DockerHost    string `json:"docker_host"`
	DataDir       string `json:"data_dir"`
	BindAddr      string `json:"bind_addr"`
	TLS           bool   `json:"tls"`
	AutoUpdate    bool   `json:"auto_update"`
	Telemetry     bool   `json:"telemetry"`
	Registry      string `json:"registry"`
	SetupComplete bool   `json:"setup_complete"`
}

// DefaultInstanceConfig returns the out-of-the-box configuration, matching the
// defaults presented in the setup wizard.
func DefaultInstanceConfig() InstanceConfig {
	return InstanceConfig{
		InstanceName:  "production",
		DockerHost:    "/var/run/docker.sock",
		DataDir:       "/var/lib/dockyard",
		BindAddr:      "0.0.0.0:9443",
		TLS:           true,
		AutoUpdate:    true,
		Telemetry:     false,
		Registry:      "docker.io",
		SetupComplete: false,
	}
}

// GetInstanceConfig returns the stored instance configuration, falling back to
// defaults when setup has not yet been run.
func (db *DB) GetInstanceConfig() (*InstanceConfig, error) {
	row := db.conn.QueryRow(`
		SELECT instance_name, docker_host, data_dir, bind_addr,
		       tls, auto_update, telemetry, registry, setup_complete
		FROM instance_config WHERE id=1
	`)
	var c InstanceConfig
	var tls, autoUpdate, telemetry, setup int
	err := row.Scan(&c.InstanceName, &c.DockerHost, &c.DataDir, &c.BindAddr,
		&tls, &autoUpdate, &telemetry, &c.Registry, &setup)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			cfg := DefaultInstanceConfig()
			return &cfg, nil
		}
		return nil, err
	}
	c.TLS = tls == 1
	c.AutoUpdate = autoUpdate == 1
	c.Telemetry = telemetry == 1
	c.SetupComplete = setup == 1
	return &c, nil
}

// SaveInstanceConfig upserts the singleton instance-configuration row.
func (db *DB) SaveInstanceConfig(c InstanceConfig) error {
	_, err := db.conn.Exec(`
		INSERT INTO instance_config
			(id, instance_name, docker_host, data_dir, bind_addr,
			 tls, auto_update, telemetry, registry, setup_complete)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			instance_name  = excluded.instance_name,
			docker_host    = excluded.docker_host,
			data_dir       = excluded.data_dir,
			bind_addr      = excluded.bind_addr,
			tls            = excluded.tls,
			auto_update    = excluded.auto_update,
			telemetry      = excluded.telemetry,
			registry       = excluded.registry,
			setup_complete = excluded.setup_complete
	`, c.InstanceName, c.DockerHost, c.DataDir, c.BindAddr,
		boolToInt(c.TLS), boolToInt(c.AutoUpdate), boolToInt(c.Telemetry),
		c.Registry, boolToInt(c.SetupComplete))
	return err
}

// IsSetupComplete reports whether first-run setup has finished (an admin exists
// and the configuration is marked complete).
func (db *DB) IsSetupComplete() (bool, error) {
	cfg, err := db.GetInstanceConfig()
	if err != nil {
		return false, err
	}
	count, err := db.CountUsers()
	if err != nil {
		return false, err
	}
	return cfg.SetupComplete && count > 0, nil
}

// ---- Sessions ---------------------------------------------------------------

// CreateSession persists a bearer token for a user with the given lifetime and
// returns the token and its expiry. The user-agent and client IP are recorded
// for the Sessions tab (empty strings are fine).
func (db *DB) CreateSession(token string, userID int64, ttl time.Duration, userAgent, ip string) (time.Time, error) {
	expires := time.Now().UTC().Add(ttl)
	_, err := db.conn.Exec(
		`INSERT INTO sessions (token, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)`,
		token, userID, expires.Format("2006-01-02 15:04:05"), userAgent, ip,
	)
	return expires, err
}

// Session is an active sign-in for a user, surfaced on the Sessions tab.
type Session struct {
	Token     string    `json:"-"`
	UserAgent string    `json:"user_agent"`
	IP        string    `json:"ip"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Current   bool      `json:"current"`
}

// ListSessionsForUser returns a user's non-expired sessions, newest first. The
// session matching currentToken is flagged so the UI can mark "this device".
func (db *DB) ListSessionsForUser(userID int64, currentToken string) ([]Session, error) {
	rows, err := db.conn.Query(`
		SELECT token, COALESCE(user_agent,''), COALESCE(ip,''), created_at, expires_at
		FROM sessions WHERE user_id=? AND expires_at >= ?
		ORDER BY created_at DESC
	`, userID, time.Now().UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sessions []Session
	for rows.Next() {
		var s Session
		var created, expires string
		if err := rows.Scan(&s.Token, &s.UserAgent, &s.IP, &created, &expires); err != nil {
			return nil, err
		}
		s.CreatedAt = parseDBTime(created)
		s.ExpiresAt = parseDBTime(expires)
		s.Current = s.Token == currentToken && currentToken != ""
		sessions = append(sessions, s)
	}
	return sessions, rows.Err()
}

// GetSessionUser returns the user for a valid (non-expired) session token, or
// nil when the token is unknown or has expired.
func (db *DB) GetSessionUser(token string) (*User, error) {
	if token == "" {
		return nil, nil
	}
	var userID int64
	var expires string
	err := db.conn.QueryRow(
		`SELECT user_id, expires_at FROM sessions WHERE token=?`, token,
	).Scan(&userID, &expires)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if exp := parseDBTime(expires); !exp.IsZero() && time.Now().UTC().After(exp) {
		_ = db.DeleteSession(token)
		return nil, nil
	}
	u, err := db.GetUserByID(userID)
	if err != nil || u == nil {
		return u, err
	}
	// Resolve the authorization tier once, here, so every authenticated request
	// path (REST middleware, hosted-git) can authorize without re-querying.
	u.Tier = db.RoleTier(u.Role)
	return u, nil
}

// DeleteSession removes a session token (sign out).
func (db *DB) DeleteSession(token string) error {
	_, err := db.conn.Exec(`DELETE FROM sessions WHERE token=?`, token)
	return err
}

func defaultStr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// ---- User management & session maintenance ----------------------------------

// migrateV10 adds the `active` flag to users (deactivation without deletion).
func (db *DB) migrateV10() error {
	db.conn.Exec(`ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`) //nolint:errcheck
	return nil
}

// migrateV20 adds the richer member fields backing the admin Members screen
// (status / 2FA / auth method / last-active) and session device attribution for
// the Sessions tab. ADD COLUMN is idempotent across restarts (the duplicate-
// column error is ignored); the status backfill runs only when the column is
// first created so it never clobbers later invited/suspended values.
func (db *DB) migrateV20() error {
	_, statusErr := db.conn.Exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`)
	db.conn.Exec(`ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0`) //nolint:errcheck
	db.conn.Exec(`ALTER TABLE users ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'`)  //nolint:errcheck
	db.conn.Exec(`ALTER TABLE users ADD COLUMN last_active_at DATETIME`)                       //nolint:errcheck
	db.conn.Exec(`ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''`)        //nolint:errcheck
	db.conn.Exec(`ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT ''`)                //nolint:errcheck
	if statusErr == nil {
		// status was just added — seed it from the legacy active flag, once.
		db.conn.Exec(`UPDATE users SET status = CASE WHEN active=1 THEN 'active' ELSE 'suspended' END`) //nolint:errcheck
	}
	return nil
}

// ListUsers returns all accounts ordered by id.
func (db *DB) ListUsers() ([]User, error) {
	rows, err := db.conn.Query(`SELECT ` + userCols + ` FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, *u)
	}
	return users, rows.Err()
}

// UpdateUser updates a user's profile, role, status and 2FA flag (not the
// password). The active flag is kept in sync with status so login-gating and
// the richer status field never disagree.
func (db *DB) UpdateUser(u User) error {
	_, err := db.conn.Exec(`
		UPDATE users SET full_name=?, email=?, role=?, status=?, active=?,
			two_factor_enabled=?, auth_method=? WHERE id=?
	`, u.FullName, u.Email, defaultStr(u.Role, "viewer"), defaultStr(u.Status, "active"),
		boolToInt(u.Active), boolToInt(u.TwoFactor),
		defaultStr(u.AuthMethod, "password"), u.ID)
	return err
}

// TouchLastActive stamps a user's last-active time to now (UTC).
func (db *DB) TouchLastActive(id int64) error {
	_, err := db.conn.Exec(
		`UPDATE users SET last_active_at=? WHERE id=?`,
		time.Now().UTC().Format("2006-01-02 15:04:05"), id,
	)
	return err
}

// SetUserPassword replaces a user's password hash.
func (db *DB) SetUserPassword(id int64, hash string) error {
	_, err := db.conn.Exec(`UPDATE users SET password_hash=? WHERE id=?`, hash, id)
	return err
}

// DeleteSessionsForUser revokes all active sessions for a user. Called when a
// password is reset so a stolen/old bearer token cannot outlive the change.
func (db *DB) DeleteSessionsForUser(id int64) error {
	_, err := db.conn.Exec(`DELETE FROM sessions WHERE user_id=?`, id)
	return err
}

// RevokeUserSessionsExcept signs a user out everywhere except the session with
// keepToken (the caller's current session, when an admin revokes their own
// other sessions). Pass an empty keepToken to revoke every session for the
// user. Returns the number of sessions removed.
func (db *DB) RevokeUserSessionsExcept(userID int64, keepToken string) (int64, error) {
	res, err := db.conn.Exec(`DELETE FROM sessions WHERE user_id=? AND token<>?`, userID, keepToken)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// DeleteUser removes an account and all of its sessions.
func (db *DB) DeleteUser(id int64) error {
	if err := db.DeleteSessionsForUser(id); err != nil {
		return err
	}
	_, err := db.conn.Exec(`DELETE FROM users WHERE id=?`, id)
	return err
}

// CountAdmins returns the number of active admin-tier accounts (owner/admin
// system roles or any custom role granting member management), used to protect
// the last administrator from deletion or demotion.
func (db *DB) CountAdmins() (int, error) {
	var n int
	err := db.conn.QueryRow(`
		SELECT COUNT(*) FROM users u
		JOIN roles r ON u.role = r.id
		WHERE r.tier = 'admin' AND u.active = 1
	`).Scan(&n)
	return n, err
}

// DeleteExpiredSessions removes sessions whose expiry has passed and returns the
// number deleted.
func (db *DB) DeleteExpiredSessions() (int64, error) {
	res, err := db.conn.Exec(
		`DELETE FROM sessions WHERE expires_at < ?`,
		time.Now().UTC().Format("2006-01-02 15:04:05"),
	)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

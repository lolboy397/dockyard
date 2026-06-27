package storage

import (
	"database/sql"
	"errors"
	"strings"
)

// OIDCConfig is the single-provider SSO (OpenID Connect) configuration. Only one
// external identity provider is supported; that covers virtually every
// self-hosted deployment (one Keycloak / Authentik / Google / Azure tenant).
type OIDCConfig struct {
	Enabled        bool   `json:"enabled"`
	IssuerURL      string `json:"issuer_url"`
	ClientID       string `json:"client_id"`
	ClientSecret   string `json:"client_secret,omitempty"` // write-only; handler strips on read
	HasSecret      bool   `json:"has_secret"`              // read-only: a secret is stored
	ButtonLabel    string `json:"button_label"`
	AllowedDomains string `json:"allowed_domains"` // CSV of permitted email domains; empty = any
	DefaultRole    string `json:"default_role"`    // role for auto-provisioned users
	AutoProvision  bool   `json:"auto_provision"`  // create a local user on first SSO login
}

// migrateV26 creates the single-row SSO configuration table.
func (db *DB) migrateV26() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS oidc_config (
			id              INTEGER PRIMARY KEY CHECK (id = 1),
			enabled         INTEGER NOT NULL DEFAULT 0,
			issuer_url      TEXT    NOT NULL DEFAULT '',
			client_id       TEXT    NOT NULL DEFAULT '',
			client_secret   TEXT    NOT NULL DEFAULT '',
			button_label    TEXT    NOT NULL DEFAULT 'Sign in with SSO',
			allowed_domains TEXT    NOT NULL DEFAULT '',
			default_role    TEXT    NOT NULL DEFAULT 'viewer',
			auto_provision  INTEGER NOT NULL DEFAULT 1
		);
	`)
	return err
}

// GetOIDCConfig returns the stored SSO configuration (secret decrypted), or a
// disabled default when none has been saved.
func (db *DB) GetOIDCConfig() (*OIDCConfig, error) {
	var c OIDCConfig
	var enabled, autoProv int
	var secret string
	err := db.read.QueryRow(`
		SELECT enabled, issuer_url, client_id, client_secret, button_label,
		       allowed_domains, default_role, auto_provision
		FROM oidc_config WHERE id = 1
	`).Scan(&enabled, &c.IssuerURL, &c.ClientID, &secret, &c.ButtonLabel,
		&c.AllowedDomains, &c.DefaultRole, &autoProv)
	if errors.Is(err, sql.ErrNoRows) {
		return &OIDCConfig{ButtonLabel: "Sign in with SSO", DefaultRole: "viewer", AutoProvision: true}, nil
	}
	if err != nil {
		return nil, err
	}
	c.Enabled = enabled == 1
	c.AutoProvision = autoProv == 1
	c.ClientSecret = decryptSecret(secret)
	c.HasSecret = c.ClientSecret != ""
	return &c, nil
}

// SaveOIDCConfig upserts the SSO configuration, encrypting the client secret.
func (db *DB) SaveOIDCConfig(c OIDCConfig) error {
	role := c.DefaultRole
	if role == "" {
		role = "viewer"
	}
	label := c.ButtonLabel
	if strings.TrimSpace(label) == "" {
		label = "Sign in with SSO"
	}
	_, err := db.conn.Exec(`
		INSERT INTO oidc_config
			(id, enabled, issuer_url, client_id, client_secret, button_label, allowed_domains, default_role, auto_provision)
		VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			enabled=excluded.enabled, issuer_url=excluded.issuer_url, client_id=excluded.client_id,
			client_secret=excluded.client_secret, button_label=excluded.button_label,
			allowed_domains=excluded.allowed_domains, default_role=excluded.default_role,
			auto_provision=excluded.auto_provision
	`, boolToInt(c.Enabled), strings.TrimSpace(c.IssuerURL), strings.TrimSpace(c.ClientID),
		encryptSecret(c.ClientSecret), label, c.AllowedDomains, role, boolToInt(c.AutoProvision))
	return err
}

// GetUserByEmail returns the first account with a matching email (case-insensitive),
// or nil if none — used to link an SSO identity to an existing account.
func (db *DB) GetUserByEmail(email string) (*User, error) {
	row := db.read.QueryRow(`SELECT `+userCols+` FROM users WHERE lower(email)=lower(?) ORDER BY id LIMIT 1`, strings.TrimSpace(email))
	u, err := scanUser(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return u, nil
}

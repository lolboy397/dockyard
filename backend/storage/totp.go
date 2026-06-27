package storage

import (
	"encoding/json"
	"strings"
)

// Two-factor (TOTP) persistence. The secret is stored AES-GCM-encrypted (reusing
// the at-rest secret layer); backup codes are stored as a JSON array of SHA-256
// hashes and consumed single-use. two_factor_enabled (added in migrateV20) is the
// confirmed flag — a non-empty totp_secret with the flag still 0 means enrollment
// was started but not yet confirmed.

// migrateV25 adds the TOTP secret + backup-code columns to users.
func (db *DB) migrateV25() error {
	for _, s := range []string{
		`ALTER TABLE users ADD COLUMN totp_secret TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN totp_backup_codes TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.conn.Exec(s); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	return nil
}

// SetTOTPSecret stores a freshly generated (pending, unconfirmed) secret for a
// user, encrypted at rest, leaving 2FA disabled until ConfirmTOTP/EnableTOTP.
func (db *DB) SetTOTPSecret(userID int64, secret string) error {
	_, err := db.conn.Exec(
		`UPDATE users SET totp_secret=?, two_factor_enabled=0, totp_backup_codes='' WHERE id=?`,
		encryptSecret(secret), userID)
	return err
}

// GetTOTPSecret returns a user's decrypted TOTP secret and whether 2FA is
// confirmed/enabled. An empty secret means the user is not enrolled.
func (db *DB) GetTOTPSecret(userID int64) (secret string, enabled bool, err error) {
	var enc string
	var en int
	if err = db.read.QueryRow(
		`SELECT COALESCE(totp_secret,''), COALESCE(two_factor_enabled,0) FROM users WHERE id=?`, userID,
	).Scan(&enc, &en); err != nil {
		return "", false, err
	}
	return decryptSecret(enc), en == 1, nil
}

// EnableTOTP marks 2FA confirmed and stores the (already hashed) backup codes.
func (db *DB) EnableTOTP(userID int64, backupHashes []string) error {
	b, _ := json.Marshal(backupHashes)
	_, err := db.conn.Exec(
		`UPDATE users SET two_factor_enabled=1, totp_backup_codes=? WHERE id=?`, string(b), userID)
	return err
}

// DisableTOTP turns off 2FA and wipes the secret + backup codes.
func (db *DB) DisableTOTP(userID int64) error {
	_, err := db.conn.Exec(
		`UPDATE users SET two_factor_enabled=0, totp_secret='', totp_backup_codes='' WHERE id=?`, userID)
	return err
}

// BackupCodesRemaining reports how many unused backup codes a user has left.
func (db *DB) BackupCodesRemaining(userID int64) (int, error) {
	var raw string
	if err := db.read.QueryRow(
		`SELECT COALESCE(totp_backup_codes,'') FROM users WHERE id=?`, userID).Scan(&raw); err != nil {
		return 0, err
	}
	return len(parseHashes(raw)), nil
}

// ConsumeBackupCode checks a candidate hash against the user's stored backup-code
// hashes; if present it is removed (single-use) and the call returns true.
func (db *DB) ConsumeBackupCode(userID int64, candidateHash string) (bool, error) {
	var raw string
	if err := db.conn.QueryRow(
		`SELECT COALESCE(totp_backup_codes,'') FROM users WHERE id=?`, userID).Scan(&raw); err != nil {
		return false, err
	}
	hashes := parseHashes(raw)
	idx := -1
	for i, h := range hashes {
		if h == candidateHash {
			idx = i
			break
		}
	}
	if idx < 0 {
		return false, nil
	}
	hashes = append(hashes[:idx], hashes[idx+1:]...)
	b, _ := json.Marshal(hashes)
	_, err := db.conn.Exec(`UPDATE users SET totp_backup_codes=? WHERE id=?`, string(b), userID)
	return err == nil, err
}

func parseHashes(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

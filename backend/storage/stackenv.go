package storage

// StackEnvVar is one environment variable for a stack. Values are encrypted at
// rest (reusing the AES-GCM secret layer) and decrypted on read.
type StackEnvVar struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	IsSecret bool   `json:"is_secret"`
}

// migrateV13 creates the per-stack environment-variable table.
func (db *DB) migrateV13() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS stack_env (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			stack_name TEXT NOT NULL,
			key        TEXT NOT NULL,
			value      TEXT NOT NULL DEFAULT '',
			is_secret  INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_stack_env_name ON stack_env(stack_name);
	`)
	return err
}

// GetStackEnv returns a stack's environment variables with values decrypted.
func (db *DB) GetStackEnv(stack string) ([]StackEnvVar, error) {
	rows, err := db.read.Query(`SELECT key, value, is_secret FROM stack_env WHERE stack_name=? ORDER BY key`, stack)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StackEnvVar
	for rows.Next() {
		var v StackEnvVar
		var secret int
		if err := rows.Scan(&v.Key, &v.Value, &secret); err != nil {
			return nil, err
		}
		v.Value = decryptSecret(v.Value)
		v.IsSecret = secret == 1
		out = append(out, v)
	}
	return out, rows.Err()
}

// SetStackEnv replaces all of a stack's environment variables, encrypting values.
func (db *DB) SetStackEnv(stack string, vars []StackEnvVar) error {
	tx, err := db.conn.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM stack_env WHERE stack_name=?`, stack); err != nil {
		tx.Rollback() //nolint:errcheck
		return err
	}
	for _, v := range vars {
		if v.Key == "" {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO stack_env (stack_name, key, value, is_secret) VALUES (?, ?, ?, ?)`,
			stack, v.Key, encryptSecret(v.Value), boolToInt(v.IsSecret),
		); err != nil {
			tx.Rollback() //nolint:errcheck
			return err
		}
	}
	return tx.Commit()
}

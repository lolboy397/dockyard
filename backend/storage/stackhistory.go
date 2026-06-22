package storage

import "time"

// StackDeploy is a compose snapshot captured at deploy time, enabling rollback.
type StackDeploy struct {
	ID        int64     `json:"id"`
	StackName string    `json:"stack_name"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

// migrateV14 creates the stack deploy-history table.
func (db *DB) migrateV14() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS stack_deploys (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			stack_name TEXT NOT NULL,
			content    TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_stack_deploys_name ON stack_deploys(stack_name);
	`)
	return err
}

// RecordStackDeploy stores a compose snapshot, keeping the last 20 per stack.
func (db *DB) RecordStackDeploy(name, content string) error {
	if _, err := db.conn.Exec(`INSERT INTO stack_deploys (stack_name, content) VALUES (?, ?)`, name, content); err != nil {
		return err
	}
	db.conn.Exec(`
		DELETE FROM stack_deploys WHERE stack_name=? AND id NOT IN (
			SELECT id FROM stack_deploys WHERE stack_name=? ORDER BY id DESC LIMIT 20
		)`, name, name) //nolint:errcheck
	return nil
}

// GetStackDeploys returns a stack's recent compose snapshots, newest first.
func (db *DB) GetStackDeploys(name string) ([]StackDeploy, error) {
	rows, err := db.read.Query(`SELECT id, stack_name, content, created_at FROM stack_deploys WHERE stack_name=? ORDER BY id DESC LIMIT 20`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StackDeploy
	for rows.Next() {
		var d StackDeploy
		var ts string
		if err := rows.Scan(&d.ID, &d.StackName, &d.Content, &ts); err != nil {
			return nil, err
		}
		d.CreatedAt = parseDBTime(ts)
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetStackDeploy returns one snapshot by id.
func (db *DB) GetStackDeploy(id int64) (*StackDeploy, error) {
	row := db.read.QueryRow(`SELECT id, stack_name, content, created_at FROM stack_deploys WHERE id=?`, id)
	var d StackDeploy
	var ts string
	if err := row.Scan(&d.ID, &d.StackName, &d.Content, &ts); err != nil {
		return nil, err
	}
	d.CreatedAt = parseDBTime(ts)
	return &d, nil
}

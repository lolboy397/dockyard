package storage

import (
	"fmt"
	"time"
)

// MetricSample is one persisted host-load reading.
type MetricSample struct {
	TS        time.Time `json:"ts"`
	CPUPct    float64   `json:"cpu_pct"`
	MemUsed   int64     `json:"mem_used"`
	MemTotal  int64     `json:"mem_total"`
	DiskUsed  int64     `json:"disk_used"`
	DiskTotal int64     `json:"disk_total"`
}

// migrateV11 creates the host metrics time-series table.
func (db *DB) migrateV11() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS metric_samples (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			ts         DATETIME NOT NULL DEFAULT (datetime('now')),
			cpu_pct    REAL    NOT NULL DEFAULT 0,
			mem_used   INTEGER NOT NULL DEFAULT 0,
			mem_total  INTEGER NOT NULL DEFAULT 0,
			disk_used  INTEGER NOT NULL DEFAULT 0,
			disk_total INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_metric_ts ON metric_samples(ts);
	`)
	return err
}

// InsertMetricSample stores one host-load reading.
func (db *DB) InsertMetricSample(s MetricSample) error {
	_, err := db.conn.Exec(
		`INSERT INTO metric_samples (cpu_pct, mem_used, mem_total, disk_used, disk_total) VALUES (?, ?, ?, ?, ?)`,
		s.CPUPct, s.MemUsed, s.MemTotal, s.DiskUsed, s.DiskTotal,
	)
	return err
}

// GetMetricHistory returns samples newer than `sinceSeconds` ago, oldest first.
func (db *DB) GetMetricHistory(sinceSeconds int) ([]MetricSample, error) {
	rows, err := db.read.Query(
		`SELECT ts, cpu_pct, mem_used, mem_total, disk_used, disk_total
		 FROM metric_samples WHERE ts >= datetime('now', ?) ORDER BY ts ASC`,
		fmt.Sprintf("-%d seconds", sinceSeconds),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MetricSample
	for rows.Next() {
		var s MetricSample
		var ts string
		if err := rows.Scan(&ts, &s.CPUPct, &s.MemUsed, &s.MemTotal, &s.DiskUsed, &s.DiskTotal); err != nil {
			return nil, err
		}
		s.TS = parseDBTime(ts)
		out = append(out, s)
	}
	return out, rows.Err()
}

// PruneMetricSamples deletes samples older than `keepSeconds`.
func (db *DB) PruneMetricSamples(keepSeconds int) error {
	_, err := db.conn.Exec(
		`DELETE FROM metric_samples WHERE ts < datetime('now', ?)`,
		fmt.Sprintf("-%d seconds", keepSeconds),
	)
	return err
}

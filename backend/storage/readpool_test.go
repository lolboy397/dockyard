package storage

import (
	"path/filepath"
	"sync"
	"testing"
)

// On disk, reads go through a separate pool from the single writer. This verifies
// the split is wired up (distinct handles) and that a row written on the writer is
// immediately visible to the read pool (WAL read-after-write consistency).
func TestReadPoolSplitAndConsistency(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "rp.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	if db.read == db.conn {
		t.Fatal("on-disk DB should use a separate read pool, not the write handle")
	}

	// Write on the writer, then read it back through the read pool.
	if err := db.LogEvent("start", "engine", "container", "web", "c1", "nginx", ""); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := db.GetEvents("", 10)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != 1 || got[0].ObjectName != "web" {
		t.Fatalf("read-after-write through the read pool = %+v, want one event for 'web'", got)
	}

	// Concurrent reads must not error or block each other (the point of the pool).
	var wg sync.WaitGroup
	errc := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := db.GetEvents("", 10); err != nil {
				errc <- err
			}
		}()
	}
	wg.Wait()
	close(errc)
	for err := range errc {
		t.Errorf("concurrent read failed: %v", err)
	}

	// The read pool is query_only: a write attempted on it must fail (safety net).
	if _, err := db.read.Exec(`INSERT INTO events (kind, message) VALUES ('x','y')`); err == nil {
		t.Error("write on the read pool should fail (query_only), but it succeeded")
	}
}

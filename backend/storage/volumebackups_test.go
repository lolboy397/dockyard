package storage

import (
	"testing"
	"time"
)

func TestBackupScheduleCRUD(t *testing.T) {
	db := newTestDB(t)

	// No schedule by default (opt-in).
	if sc, err := db.GetBackupSchedule("pgdata"); err != nil || sc != nil {
		t.Fatalf("expected nil schedule, got %+v err=%v", sc, err)
	}

	// Enable one.
	if err := db.UpsertBackupSchedule(BackupSchedule{
		VolumeName: "pgdata", Enabled: true, IntervalHours: 24, Keep: 7, StopContainer: true,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	sc, err := db.GetBackupSchedule("pgdata")
	if err != nil || sc == nil || !sc.Enabled || sc.IntervalHours != 24 || sc.Keep != 7 || !sc.StopContainer {
		t.Fatalf("get after upsert: %+v err=%v", sc, err)
	}
	if sc.LastRunAt != nil {
		t.Errorf("last_run should be nil before first run, got %v", sc.LastRunAt)
	}

	// Enabled list includes it.
	if list, _ := db.ListEnabledBackupSchedules(); len(list) != 1 {
		t.Fatalf("enabled list = %d, want 1", len(list))
	}

	// Stamp a run.
	if err := db.TouchBackupScheduleRun("pgdata"); err != nil {
		t.Fatalf("touch: %v", err)
	}
	sc, _ = db.GetBackupSchedule("pgdata")
	if sc.LastRunAt == nil || time.Since(*sc.LastRunAt) > time.Minute {
		t.Errorf("last_run not stamped: %+v", sc.LastRunAt)
	}

	// Update (disable) — should drop out of the enabled list, settings preserved.
	if err := db.UpsertBackupSchedule(BackupSchedule{
		VolumeName: "pgdata", Enabled: false, IntervalHours: 12, Keep: 3, StopContainer: false,
	}); err != nil {
		t.Fatalf("upsert disable: %v", err)
	}
	if list, _ := db.ListEnabledBackupSchedules(); len(list) != 0 {
		t.Errorf("enabled list after disable = %d, want 0", len(list))
	}
	sc, _ = db.GetBackupSchedule("pgdata")
	if sc.Enabled || sc.IntervalHours != 12 || sc.Keep != 3 {
		t.Errorf("disabled schedule not updated: %+v", sc)
	}
}

func TestVolumeBackupCRUD(t *testing.T) {
	db := newTestDB(t)

	rec, err := db.CreateVolumeBackup("pgdata", "pgdata/100.tar.gz", 2048, true, "nightly")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if rec.ID == 0 || rec.VolumeName != "pgdata" || rec.SizeBytes != 2048 || !rec.Consistent || rec.Note != "nightly" {
		t.Fatalf("unexpected row: %+v", rec)
	}

	got, err := db.GetVolumeBackup(rec.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.File != "pgdata/100.tar.gz" || !got.Consistent {
		t.Errorf("get mismatch: %+v", got)
	}

	list, err := db.ListVolumeBackups("pgdata")
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v len=%d", err, len(list))
	}

	if err := db.DeleteVolumeBackup(rec.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if list, _ := db.ListVolumeBackups("pgdata"); len(list) != 0 {
		t.Errorf("after delete len=%d, want 0", len(list))
	}
}

func TestVolumeBackupRetention(t *testing.T) {
	db := newTestDB(t)

	for i := 0; i < 12; i++ {
		if _, err := db.CreateVolumeBackup("vol", "vol/f.tar.gz", int64(i), false, ""); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	// A second volume's backups must be untouched by the first's retention.
	if _, err := db.CreateVolumeBackup("other", "other/x.tar.gz", 1, false, ""); err != nil {
		t.Fatalf("create other: %v", err)
	}

	files, err := db.PruneVolumeBackups("vol", 10)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if len(files) != 2 {
		t.Errorf("pruned %d files, want 2", len(files))
	}
	if list, _ := db.ListVolumeBackups("vol"); len(list) != 10 {
		t.Errorf("kept %d, want 10", len(list))
	}
	if list, _ := db.ListVolumeBackups("other"); len(list) != 1 {
		t.Errorf("other volume affected: kept %d, want 1", len(list))
	}

	// Newest-first ordering: the most recent insert (size 11) should be first.
	list, _ := db.ListVolumeBackups("vol")
	if len(list) > 0 && list[0].SizeBytes != 11 {
		t.Errorf("newest-first broken: first size = %d, want 11", list[0].SizeBytes)
	}
}

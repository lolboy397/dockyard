package storage

import (
	"strings"
	"testing"
	"time"
)

func newTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open in-memory db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestUserCRUDAndAdminCount(t *testing.T) {
	db := newTestDB(t)

	u, err := db.CreateUser(User{FullName: "Admin", Email: "a@x.io", Username: "admin", PasswordHash: "h", Role: "admin"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !u.Active {
		t.Error("a new user should be active by default")
	}
	if u.Role != "admin" {
		t.Errorf("role = %q, want admin", u.Role)
	}
	if n, _ := db.CountAdmins(); n != 1 {
		t.Errorf("CountAdmins = %d, want 1", n)
	}

	got, err := db.GetUserByUsername("admin")
	if err != nil || got == nil {
		t.Fatalf("get by username: %v", err)
	}
	if got.ID != u.ID {
		t.Errorf("id mismatch: %d vs %d", got.ID, u.ID)
	}

	// Deactivating the admin should drop the active-admin count to zero.
	got.Active = false
	if err := db.UpdateUser(*got); err != nil {
		t.Fatalf("update: %v", err)
	}
	if n, _ := db.CountAdmins(); n != 0 {
		t.Errorf("active admins = %d after deactivate, want 0", n)
	}

	users, _ := db.ListUsers()
	if len(users) != 1 {
		t.Errorf("ListUsers = %d, want 1", len(users))
	}

	if err := db.DeleteUser(u.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if users, _ := db.ListUsers(); len(users) != 0 {
		t.Errorf("ListUsers after delete = %d, want 0", len(users))
	}
}

func TestSetUserPassword(t *testing.T) {
	db := newTestDB(t)
	u, _ := db.CreateUser(User{Username: "u", PasswordHash: "old", Role: "viewer"})
	if err := db.SetUserPassword(u.ID, "new-hash"); err != nil {
		t.Fatalf("set password: %v", err)
	}
	got, _ := db.GetUserByID(u.ID)
	if got.PasswordHash != "new-hash" {
		t.Errorf("password hash = %q, want new-hash", got.PasswordHash)
	}
}

func TestReconcileInterruptedJobs(t *testing.T) {
	db := newTestDB(t)

	// Builds: queued + running were interrupted by the "restart"; succeeded is terminal.
	for _, b := range []Build{
		{ID: "b-queued", Name: "img", Tag: "latest", Status: "queued"},
		{ID: "b-running", Name: "img", Tag: "latest", Status: "running"},
		{ID: "b-done", Name: "img", Tag: "latest", Status: "succeeded"},
	} {
		if err := db.CreateBuild(&b); err != nil {
			t.Fatalf("create build %s: %v", b.ID, err)
		}
	}

	// Projects: a 'building' one is interrupted; a 'running' one must be left alone
	// (its containers may still be up after a backend restart).
	pBuilding, err := db.CreateProject(Project{Name: "p-building", Path: "/tmp/p-building", Type: "compose"})
	if err != nil {
		t.Fatalf("create building project: %v", err)
	}
	if err := db.UpdateProjectStatus(pBuilding.ID, "building", ""); err != nil {
		t.Fatalf("set building: %v", err)
	}
	pRunning, err := db.CreateProject(Project{Name: "p-running", Path: "/tmp/p-running", Type: "compose"})
	if err != nil {
		t.Fatalf("create running project: %v", err)
	}
	if err := db.UpdateProjectStatus(pRunning.ID, "running", "abc123"); err != nil {
		t.Fatalf("set running: %v", err)
	}

	n, err := db.ReconcileInterruptedJobs()
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if n != 3 { // 2 builds + 1 project
		t.Errorf("reconciled = %d, want 3", n)
	}

	// Interrupted builds become a clean terminal failure with an explanation.
	for _, id := range []string{"b-queued", "b-running"} {
		b, err := db.GetBuild(id)
		if err != nil {
			t.Fatalf("get build %s: %v", id, err)
		}
		if b.Status != "failed" {
			t.Errorf("build %s status = %q, want failed", id, b.Status)
		}
		if b.Progress != 100 {
			t.Errorf("build %s progress = %d, want 100", id, b.Progress)
		}
		if b.FinishedAt == nil {
			t.Errorf("build %s finished_at not set", id)
		}
		if !strings.Contains(b.Logs, "interrupted by a backend restart") {
			t.Errorf("build %s logs missing interruption marker: %q", id, b.Logs)
		}
	}

	// A terminal build is untouched.
	if b, _ := db.GetBuild("b-done"); b.Status != "succeeded" {
		t.Errorf("terminal build status = %q, want succeeded", b.Status)
	}

	// The interrupted project fails; the running one is preserved.
	if p, _ := db.GetProject(pBuilding.ID); p.Status != "failed" {
		t.Errorf("building project status = %q, want failed", p.Status)
	}
	if p, _ := db.GetProject(pRunning.ID); p.Status != "running" {
		t.Errorf("running project status = %q, want running (must be preserved)", p.Status)
	}

	// Idempotent: a second pass has nothing left to reconcile.
	if n, _ := db.ReconcileInterruptedJobs(); n != 0 {
		t.Errorf("second reconcile = %d, want 0", n)
	}
}

func TestSessions(t *testing.T) {
	db := newTestDB(t)
	u, _ := db.CreateUser(User{Username: "u", PasswordHash: "h", Role: "viewer"})

	if _, err := db.CreateSession("valid", u.ID, time.Hour, "", ""); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if su, _ := db.GetSessionUser("valid"); su == nil || su.ID != u.ID {
		t.Error("a valid session should resolve to its user")
	}

	if _, err := db.CreateSession("expired", u.ID, -time.Hour, "", ""); err != nil {
		t.Fatalf("create expired session: %v", err)
	}
	if n, _ := db.DeleteExpiredSessions(); n < 1 {
		t.Error("an expired session should be swept")
	}
}

func TestDeleteSessionsForUser(t *testing.T) {
	db := newTestDB(t)
	u, _ := db.CreateUser(User{Username: "u", PasswordHash: "h", Role: "operator"})
	if _, err := db.CreateSession("tok", u.ID, time.Hour, "", ""); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if su, _ := db.GetSessionUser("tok"); su == nil {
		t.Fatal("session should resolve before revocation")
	}
	if err := db.DeleteSessionsForUser(u.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if su, _ := db.GetSessionUser("tok"); su != nil {
		t.Error("session should be revoked after DeleteSessionsForUser (password-change containment)")
	}
}

func TestRevokeUserSessionsExcept(t *testing.T) {
	db := newTestDB(t)
	u, _ := db.CreateUser(User{Username: "u", PasswordHash: "h", Role: "viewer"})
	for _, tok := range []string{"keep", "a", "b"} {
		if _, err := db.CreateSession(tok, u.ID, time.Hour, "", ""); err != nil {
			t.Fatalf("create session %s: %v", tok, err)
		}
	}
	n, err := db.RevokeUserSessionsExcept(u.ID, "keep")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if n != 2 {
		t.Errorf("revoked = %d, want 2 (all but the kept token)", n)
	}
	if su, _ := db.GetSessionUser("keep"); su == nil {
		t.Error("the kept (current) session must survive")
	}
	if su, _ := db.GetSessionUser("a"); su != nil {
		t.Error("other sessions must be revoked")
	}
}

func TestPruneEvents(t *testing.T) {
	db := newTestDB(t)
	// A recent event (kept) and one backdated beyond the retention window.
	if err := db.LogEvent("audit", "alice", "api", "stacks", "", "", "POST /stacks"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.conn.Exec(
		`INSERT INTO events (created_at, kind, actor, object_type, object_name, message) VALUES (datetime('now','-200 days'), 'audit', 'bob', 'api', 'old', 'old')`,
	); err != nil {
		t.Fatal(err)
	}
	n, err := db.PruneEvents(90 * 24 * 3600)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if n != 1 {
		t.Errorf("pruned %d events, want 1 (only the 200-day-old row)", n)
	}
	got, _ := db.GetEvents("", 100)
	if len(got) != 1 {
		t.Errorf("remaining events = %d, want 1 (the recent one)", len(got))
	}
}

func TestLogEventsBatch(t *testing.T) {
	db := newTestDB(t)

	batch := []Event{
		{Kind: "start", ObjectType: "container", ObjectName: "a", ContainerID: "c1"},
		{Kind: "die", ObjectType: "container", ObjectName: "b", ContainerID: "c2"},
		{Kind: "pull", Actor: "user", ObjectType: "image", ObjectName: "nginx"},
	}
	if err := db.LogEventsBatch(batch); err != nil {
		t.Fatalf("batch insert: %v", err)
	}

	got, err := db.GetEvents("", 100)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("events after batch = %d, want 3", len(got))
	}

	byName := map[string]Event{}
	for _, e := range got {
		byName[e.ObjectName] = e
	}
	if byName["a"].Actor != "engine" {
		t.Errorf("empty actor should default to 'engine', got %q", byName["a"].Actor)
	}
	if byName["nginx"].Actor != "user" {
		t.Errorf("explicit actor should be preserved, got %q", byName["nginx"].Actor)
	}

	// An empty batch is a no-op, not an error.
	if err := db.LogEventsBatch(nil); err != nil {
		t.Errorf("empty batch should be a no-op, got %v", err)
	}
}

func TestEventFilters(t *testing.T) {
	db := newTestDB(t)

	// Two noisy watchtower events + one real signal event.
	db.LogEvent("start", "engine", "container", "watchtower", "c1", "containrrr/watchtower", "") //nolint:errcheck
	db.LogEvent("die", "engine", "container", "watchtower", "c1", "containrrr/watchtower", "")   //nolint:errcheck
	db.LogEvent("start", "engine", "container", "web_1", "c2", "nginx", "")                       //nolint:errcheck

	// Reject a rule that would mute everything.
	if _, err := db.CreateEventFilter("", ""); err != ErrEmptyEventFilter {
		t.Fatalf("empty filter err = %v, want ErrEmptyEventFilter", err)
	}

	// Mute everything from watchtower (name substring, any kind).
	f, err := db.CreateEventFilter("watchtower", "")
	if err != nil {
		t.Fatalf("create filter: %v", err)
	}

	rules, err := db.EnabledEventFilters()
	if err != nil {
		t.Fatalf("enabled filters: %v", err)
	}

	// Default (muted excluded) → only the web event remains.
	got, err := db.GetEventsFiltered("", 100, rules, false)
	if err != nil {
		t.Fatalf("filtered: %v", err)
	}
	if len(got) != 1 || got[0].ObjectName != "web_1" {
		t.Errorf("filtered events = %+v, want only web_1", got)
	}

	// Count of hidden events.
	if n, _ := db.CountMutedEvents(rules); n != 2 {
		t.Errorf("muted count = %d, want 2", n)
	}

	// include_muted → all three returned.
	if all, _ := db.GetEventsFiltered("", 100, rules, true); len(all) != 3 {
		t.Errorf("include_muted events = %d, want 3", len(all))
	}

	// Disabling the rule reveals everything again.
	if err := db.SetEventFilterEnabled(f.ID, false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	rules, _ = db.EnabledEventFilters()
	if got, _ := db.GetEventsFiltered("", 100, rules, false); len(got) != 3 {
		t.Errorf("after disable events = %d, want 3", len(got))
	}

	// The LIKE pattern must match literally: "web_1" must not match "webX1".
	// (Underscore is a LIKE wildcard; it should be escaped.)
	db.SetEventFilterEnabled(f.ID, true) //nolint:errcheck
	db.LogEvent("start", "engine", "container", "webX1", "c3", "nginx", "") //nolint:errcheck
	exact, err := db.CreateEventFilter("web_1", "")
	if err != nil {
		t.Fatalf("create exact filter: %v", err)
	}
	rules, _ = db.EnabledEventFilters()
	got, _ = db.GetEventsFiltered("", 100, rules, false)
	for _, e := range got {
		if e.ObjectName == "web_1" {
			t.Errorf("web_1 should be muted by the web_1 rule")
		}
	}
	foundWebX1 := false
	for _, e := range got {
		if e.ObjectName == "webX1" {
			foundWebX1 = true
		}
	}
	if !foundWebX1 {
		t.Error("webX1 must NOT be muted by the literal web_1 rule (underscore wildcard escaped)")
	}
	_ = exact

	// Delete removes the rule.
	if err := db.DeleteEventFilter(f.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	all, _ := db.ListEventFilters()
	for _, r := range all {
		if r.ID == f.ID {
			t.Error("deleted filter still present")
		}
	}
}

func TestMetricSamples(t *testing.T) {
	db := newTestDB(t)
	if err := db.InsertMetricSample(MetricSample{CPUPct: 12.5, MemUsed: 100, MemTotal: 1000}); err != nil {
		t.Fatalf("insert sample: %v", err)
	}
	got, err := db.GetMetricHistory(3600)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("samples = %d, want 1", len(got))
	}
	if got[0].CPUPct != 12.5 {
		t.Errorf("cpu = %v, want 12.5", got[0].CPUPct)
	}
}

func TestSecretEncryption(t *testing.T) {
	newTestDB(t) // ensures initSecretKey has run
	ct := encryptSecret("ghp_supersecret")
	if ct == "ghp_supersecret" || !strings.HasPrefix(ct, "enc:") {
		t.Fatalf("expected an encrypted value, got %q", ct)
	}
	if got := decryptSecret(ct); got != "ghp_supersecret" {
		t.Errorf("round-trip = %q, want ghp_supersecret", got)
	}
	// Legacy (unprefixed) values pass through unchanged.
	if got := decryptSecret("legacy-plaintext"); got != "legacy-plaintext" {
		t.Errorf("legacy passthrough = %q, want legacy-plaintext", got)
	}
}

func TestAlertRules(t *testing.T) {
	db := newTestDB(t)
	a, err := db.CreateAlertRule(AlertRule{Name: "cpu", Type: "host_cpu", Threshold: 80, Channel: "in_app", Enabled: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if a.ID == 0 || !a.Enabled || a.Channel != "in_app" {
		t.Fatalf("rule not stored correctly: %+v", a)
	}
	a.Enabled = false
	if err := db.UpdateAlertRule(*a); err != nil {
		t.Fatalf("update: %v", err)
	}
	list, _ := db.ListAlertRules()
	if len(list) != 1 || list[0].Enabled {
		t.Errorf("update not persisted: %+v", list)
	}
	if err := db.DeleteAlertRule(a.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if list, _ := db.ListAlertRules(); len(list) != 0 {
		t.Errorf("delete left %d rules", len(list))
	}
}

func TestStackEnv(t *testing.T) {
	db := newTestDB(t)
	if err := db.SetStackEnv("web", []StackEnvVar{
		{Key: "FOO", Value: "bar"},
		{Key: "SECRET", Value: "s3cr3t", IsSecret: true},
	}); err != nil {
		t.Fatalf("set: %v", err)
	}
	vars, err := db.GetStackEnv("web")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(vars) != 2 {
		t.Fatalf("got %d vars, want 2", len(vars))
	}
	byKey := map[string]StackEnvVar{}
	for _, v := range vars {
		byKey[v.Key] = v
	}
	if byKey["SECRET"].Value != "s3cr3t" || !byKey["SECRET"].IsSecret {
		t.Errorf("secret not round-tripped: %+v", byKey["SECRET"])
	}
	// SetStackEnv replaces the whole set.
	if err := db.SetStackEnv("web", []StackEnvVar{{Key: "FOO", Value: "baz"}}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if vars, _ := db.GetStackEnv("web"); len(vars) != 1 || vars[0].Value != "baz" {
		t.Errorf("replace failed: %+v", vars)
	}
}

func TestProjectDeploy(t *testing.T) {
	db := newTestDB(t)
	if e, _, found := db.GetProjectDeploy(7); found || e {
		t.Error("no deploy config should exist yet")
	}
	tok, err := db.EnableProjectDeploy(7)
	if err != nil || tok == "" {
		t.Fatalf("enable: %v tok=%q", err, tok)
	}
	if !db.ValidateProjectDeploy(7, tok) {
		t.Error("valid token rejected")
	}
	if db.ValidateProjectDeploy(7, "wrong") {
		t.Error("wrong token accepted")
	}
	if tok2, _ := db.EnableProjectDeploy(7); tok2 != tok {
		t.Error("token should be stable")
	}
	if err := db.DisableProjectDeploy(7); err != nil {
		t.Fatal(err)
	}
	if db.ValidateProjectDeploy(7, tok) {
		t.Error("disabled deploy should reject the token")
	}
}

func TestStackWebhook(t *testing.T) {
	db := newTestDB(t)
	tok, err := db.EnsureStackWebhook("web")
	if err != nil || tok == "" {
		t.Fatalf("ensure: %v tok=%q", err, tok)
	}
	if tok2, _ := db.EnsureStackWebhook("web"); tok2 != tok {
		t.Error("token should be stable across calls")
	}
	if !db.ValidateStackWebhook("web", tok) {
		t.Error("valid token rejected")
	}
	if db.ValidateStackWebhook("web", "wrong") {
		t.Error("wrong token accepted")
	}
	if db.ValidateStackWebhook("nope", tok) {
		t.Error("unknown stack accepted")
	}
}

func TestEventLogAttribution(t *testing.T) {
	db := newTestDB(t)
	if err := db.LogEvent("audit", "alice", "api", "containers/abc/stop", "", "", "POST /api/v1/containers/abc/stop"); err != nil {
		t.Fatalf("log event: %v", err)
	}
	events, err := db.GetEvents("audit", 10)
	if err != nil {
		t.Fatalf("get events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	if events[0].Actor != "alice" {
		t.Errorf("actor = %q, want alice", events[0].Actor)
	}
}

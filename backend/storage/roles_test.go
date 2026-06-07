package storage

import "testing"

func TestSystemRolesSeeded(t *testing.T) {
	db := newTestDB(t)

	roles, err := db.ListRoles()
	if err != nil {
		t.Fatalf("list roles: %v", err)
	}
	if len(roles) != 5 {
		t.Fatalf("seeded roles = %d, want 5 system roles", len(roles))
	}

	wantTier := map[string]string{
		"owner": "admin", "admin": "admin",
		"maintainer": "operator", "developer": "operator",
		"viewer": "viewer",
	}
	for _, r := range roles {
		if r.Type != "system" {
			t.Errorf("role %s type = %q, want system", r.ID, r.Type)
		}
		if want := wantTier[r.ID]; r.Tier != want {
			t.Errorf("role %s tier = %q, want %q", r.ID, r.Tier, want)
		}
		// Every capability key must be present (backfilled) for a complete matrix.
		for _, k := range capabilityKeys() {
			if _, ok := r.Capabilities[k]; !ok {
				t.Errorf("role %s missing capability %q", r.ID, k)
			}
		}
	}
}

func TestRoleTierAndExists(t *testing.T) {
	db := newTestDB(t)

	if !mustExist(t, db, "owner") || !mustExist(t, db, "viewer") {
		t.Error("system roles should exist")
	}
	if ok, _ := db.RoleExists("nope"); ok {
		t.Error("unknown role should not exist")
	}
	if db.RoleTier("admin") != "admin" {
		t.Error("admin should be admin tier")
	}
	if db.RoleTier("maintainer") != "operator" {
		t.Error("maintainer should be operator tier")
	}
	if db.RoleTier("ghost") != "viewer" {
		t.Error("unknown role should default to least privilege (viewer)")
	}
}

func TestCreateAndDeleteCustomRole(t *testing.T) {
	db := newTestDB(t)

	// A role granting member management derives the admin tier.
	r, err := db.CreateRole(Role{
		ID:          "custom_oncall",
		Name:        "On-call",
		Description: "Operate production during incidents.",
		Icon:        "siren",
		Capabilities: map[string]string{
			"containers.lifecycle": CapScoped,
			"deploy.rollback":      CapScoped,
		},
	})
	if err != nil {
		t.Fatalf("create role: %v", err)
	}
	if r.Type != "custom" {
		t.Errorf("type = %q, want custom", r.Type)
	}
	if r.Tier != "operator" {
		t.Errorf("tier = %q, want operator (has operate caps, no member mgmt)", r.Tier)
	}
	if r.Capabilities["org.members"] != CapNone {
		t.Errorf("unspecified capability should default to none, got %q", r.Capabilities["org.members"])
	}

	// Assign a member, then deletion must be refused until reassigned.
	if _, err := db.CreateUser(User{Username: "oncaller", PasswordHash: "h", Role: "custom_oncall"}); err != nil {
		t.Fatalf("create user: %v", err)
	}
	if n, _ := db.CountUsersByRole("custom_oncall"); n != 1 {
		t.Errorf("member count = %d, want 1", n)
	}
	if err := db.DeleteRole("custom_oncall"); err == nil {
		t.Error("deleting a role with members should be refused")
	}

	// System roles can never be deleted.
	if err := db.DeleteRole("admin"); err == nil {
		t.Error("system roles must not be deletable")
	}
}

func TestCustomAdminTierProtectsLastAdmin(t *testing.T) {
	db := newTestDB(t)

	// A custom role granting member management is admin-tier and so counts toward
	// the last-admin protection.
	if _, err := db.CreateRole(Role{
		ID:           "custom_superadmin",
		Name:         "Super Admin",
		Capabilities: map[string]string{"org.members": CapAll, "org.roles": CapAll},
	}); err != nil {
		t.Fatalf("create role: %v", err)
	}
	if db.RoleTier("custom_superadmin") != "admin" {
		t.Fatal("member-management role should be admin tier")
	}
	if _, err := db.CreateUser(User{Username: "boss", PasswordHash: "h", Role: "custom_superadmin"}); err != nil {
		t.Fatalf("create user: %v", err)
	}
	if n, _ := db.CountAdmins(); n != 1 {
		t.Errorf("CountAdmins = %d, want 1 (custom admin-tier counts)", n)
	}
}

func mustExist(t *testing.T, db *DB, id string) bool {
	t.Helper()
	ok, err := db.RoleExists(id)
	if err != nil {
		t.Fatalf("RoleExists(%q): %v", id, err)
	}
	return ok
}

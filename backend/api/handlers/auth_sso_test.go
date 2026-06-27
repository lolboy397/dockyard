package handlers

import (
	"testing"

	"docker-manager/backend/storage"
)

func TestProvisionSSOUser(t *testing.T) {
	db := newTestDBH(t)
	h := NewAuthHandlers(db, nil)

	// Email domain outside the allow-list is rejected.
	cfg := &storage.OIDCConfig{AutoProvision: true, AllowedDomains: "example.com", DefaultRole: "viewer"}
	if _, err := h.provisionSSOUser(cfg, "user@other.com", "U"); err == nil || err.Error() != "domain_not_allowed" {
		t.Errorf("expected domain_not_allowed, got %v", err)
	}

	// Auto-provision off + no existing account → rejected.
	off := &storage.OIDCConfig{AutoProvision: false, DefaultRole: "viewer"}
	if _, err := h.provisionSSOUser(off, "new@example.com", "New"); err == nil || err.Error() != "no_account" {
		t.Errorf("expected no_account, got %v", err)
	}

	// Auto-provision creates a user with the default role + sso auth method.
	u, err := h.provisionSSOUser(cfg, "alice@example.com", "Alice Example")
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if u.Email != "alice@example.com" || u.Role != "viewer" || u.AuthMethod != "sso" || u.FullName != "Alice Example" {
		t.Errorf("unexpected provisioned user: %+v", u)
	}

	// A second sign-in with the same email (different case) matches, no duplicate.
	u2, err := h.provisionSSOUser(cfg, "ALICE@example.com", "Alice")
	if err != nil {
		t.Fatalf("second provision: %v", err)
	}
	if u2.ID != u.ID {
		t.Errorf("expected the same account, got %d vs %d", u2.ID, u.ID)
	}

	// An unknown default role falls back to viewer.
	bad := &storage.OIDCConfig{AutoProvision: true, DefaultRole: "nonexistent"}
	u3, err := h.provisionSSOUser(bad, "bob@whatever.com", "Bob")
	if err != nil {
		t.Fatalf("provision bob: %v", err)
	}
	if u3.Role != "viewer" {
		t.Errorf("fallback role = %q, want viewer", u3.Role)
	}
}

func TestUniqueUsername(t *testing.T) {
	db := newTestDBH(t)
	h := NewAuthHandlers(db, nil)

	if got := h.uniqueUsername("sam@example.com"); got != "sam" {
		t.Errorf("uniqueUsername = %q, want sam", got)
	}
	if _, err := db.CreateUser(storage.User{Username: "sam", PasswordHash: "h", Role: "viewer"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := h.uniqueUsername("sam@other.com"); got != "sam1" {
		t.Errorf("collision username = %q, want sam1", got)
	}
}

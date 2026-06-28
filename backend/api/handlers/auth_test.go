package handlers

import "testing"

// canViewLogs must be strictly additive: a viewer-tier user whose role grants
// logs.view (resolved into CanViewLogs) may read logs, the capability must not
// confer write access, and operator/admin keep log access regardless of the flag.
func TestCanViewLogsAdditive(t *testing.T) {
	r := reqWithRole("viewer")
	if canViewLogs(r) {
		t.Fatal("plain viewer should not see logs")
	}
	UserFromContext(r.Context()).CanViewLogs = true
	if !canViewLogs(r) {
		t.Error("viewer granted logs.view should see logs")
	}
	if canWrite(r) {
		t.Error("logs.view must NOT grant write access")
	}
	for _, role := range []string{"operator", "admin"} {
		if !canViewLogs(reqWithRole(role)) {
			t.Errorf("%s must keep log access regardless of the capability", role)
		}
	}
}

func TestHashVerifyPassword(t *testing.T) {
	hash, err := hashPassword("correct horse battery")
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}
	if !verifyPassword("correct horse battery", hash) {
		t.Error("valid password was rejected")
	}
	if verifyPassword("wrong password", hash) {
		t.Error("wrong password was accepted")
	}
	if verifyPassword("correct horse battery", "not-a-valid-hash") {
		t.Error("malformed hash was accepted")
	}
}

func TestHashPasswordUsesRandomSalt(t *testing.T) {
	a, _ := hashPassword("samePassword1")
	b, _ := hashPassword("samePassword1")
	if a == b {
		t.Error("two hashes of the same password should differ (random salt)")
	}
}

func TestIsMutating(t *testing.T) {
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		if !isMutating(m) {
			t.Errorf("%s should be mutating", m)
		}
	}
	for _, m := range []string{"GET", "HEAD", "OPTIONS"} {
		if isMutating(m) {
			t.Errorf("%s should not be mutating", m)
		}
	}
}

func TestPublicPaths(t *testing.T) {
	public := []string{
		"/health", "/api/v1/auth/status", "/api/v1/auth/setup",
		"/api/v1/auth/login", "/api/v1/auth/test-connection",
	}
	for _, p := range public {
		if !publicPaths[p] {
			t.Errorf("%s should be public", p)
		}
	}
	protected := []string{
		"/api/v1/containers", "/api/v1/auth/me", "/api/v1/users", "/api/v1/auth/logout",
	}
	for _, p := range protected {
		if publicPaths[p] {
			t.Errorf("%s must NOT be public", p)
		}
	}
}

func TestIsAdminPath(t *testing.T) {
	if !isAdminPath("/api/v1/users") || !isAdminPath("/api/v1/users/3") {
		t.Error("user routes should be admin-only")
	}
	if isAdminPath("/api/v1/containers") {
		t.Error("container routes are not admin-only")
	}
}

func TestLoginLimiter(t *testing.T) {
	l := newLoginLimiter()
	if l.blocked("alice") {
		t.Error("a fresh key should not be blocked")
	}
	for i := 0; i < 5; i++ {
		l.fail("alice")
	}
	if !l.blocked("alice") {
		t.Error("should be locked out after 5 failures")
	}
	if l.blocked("bob") {
		t.Error("lockout must be per-account")
	}
	l.reset("alice")
	if l.blocked("alice") {
		t.Error("reset (successful login) should clear the lockout")
	}
}

func TestValidRole(t *testing.T) {
	for _, r := range []string{"admin", "operator", "viewer"} {
		if !validRole(r) {
			t.Errorf("%s should be a valid role", r)
		}
	}
	for _, r := range []string{"superuser", "", "Admin", "root"} {
		if validRole(r) {
			t.Errorf("%q should be rejected", r)
		}
	}
}

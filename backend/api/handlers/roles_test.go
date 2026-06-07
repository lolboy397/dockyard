package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

func newTestDBH(t *testing.T) *storage.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func withURLParam(r *http.Request, key, val string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, val)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

func TestRoleHandlersListAndCapabilities(t *testing.T) {
	db := newTestDBH(t)
	h := NewRoleHandlers(db)

	rec := httptest.NewRecorder()
	h.List(rec, httptest.NewRequest(http.MethodGet, "/api/v1/roles", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("List status = %d", rec.Code)
	}
	var roles []storage.Role
	if err := json.Unmarshal(rec.Body.Bytes(), &roles); err != nil {
		t.Fatalf("decode roles: %v", err)
	}
	if len(roles) != 5 {
		t.Errorf("roles = %d, want 5 system roles", len(roles))
	}

	rec = httptest.NewRecorder()
	h.Capabilities(rec, httptest.NewRequest(http.MethodGet, "/api/v1/roles/capabilities", nil))
	var cat struct {
		Groups []struct {
			Group string              `json:"group"`
			Rows  []map[string]string `json:"rows"`
		} `json:"groups"`
		States []map[string]string `json:"states"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatalf("decode capabilities: %v", err)
	}
	if len(cat.Groups) == 0 || len(cat.States) != 4 {
		t.Errorf("capabilities groups=%d states=%d, want groups>0 states=4", len(cat.Groups), len(cat.States))
	}
}

func TestRoleHandlerCreateCustom(t *testing.T) {
	db := newTestDBH(t)
	h := NewRoleHandlers(db)

	body, _ := json.Marshal(map[string]any{
		"name":        "On-call SRE",
		"description": "Operate production during incidents.",
		"icon":        "siren",
		"capabilities": map[string]string{
			"containers.lifecycle": "scoped",
			"deploy.rollback":      "scoped",
		},
	})
	rec := httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/v1/roles", bytes.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("Create status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var role storage.Role
	if err := json.Unmarshal(rec.Body.Bytes(), &role); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if role.ID != "custom_on-call-sre" {
		t.Errorf("id = %q, want custom_on-call-sre", role.ID)
	}
	if role.Type != "custom" || role.Tier != "operator" {
		t.Errorf("type=%q tier=%q, want custom/operator", role.Type, role.Tier)
	}

	// A second role with the same name must conflict.
	rec = httptest.NewRecorder()
	h.Create(rec, httptest.NewRequest(http.MethodPost, "/api/v1/roles", bytes.NewReader(body)))
	if rec.Code != http.StatusConflict {
		t.Errorf("duplicate create status = %d, want 409", rec.Code)
	}
}

func TestUserUpdateStatusRoleAnd2FA(t *testing.T) {
	db := newTestDBH(t)
	h := NewAuthHandlers(db, nil)

	// Two admins so the last-admin guard does not block edits to the target.
	if _, err := db.CreateUser(storage.User{Username: "root", PasswordHash: "h", Role: "admin"}); err != nil {
		t.Fatalf("create root: %v", err)
	}
	target, err := db.CreateUser(storage.User{Username: "mara", PasswordHash: "h", Role: "viewer", Status: "active"})
	if err != nil {
		t.Fatalf("create target: %v", err)
	}

	body, _ := json.Marshal(map[string]any{"role": "maintainer", "status": "suspended", "twoFactor": true})
	r := withURLParam(httptest.NewRequest(http.MethodPatch, "/api/v1/users/"+strconv.FormatInt(target.ID, 10), bytes.NewReader(body)), "id", strconv.FormatInt(target.ID, 10))
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("UpdateUser status = %d, body=%s", rec.Code, rec.Body.String())
	}

	got, _ := db.GetUserByID(target.ID)
	if got.Role != "maintainer" {
		t.Errorf("role = %q, want maintainer", got.Role)
	}
	if got.Status != "suspended" || got.Active {
		t.Errorf("status=%q active=%v, want suspended/false (active mirrors status)", got.Status, got.Active)
	}
	if !got.TwoFactor {
		t.Error("two-factor should be enabled")
	}
}

func TestUserUpdateRejectsUnknownRole(t *testing.T) {
	db := newTestDBH(t)
	h := NewAuthHandlers(db, nil)
	u, _ := db.CreateUser(storage.User{Username: "u", PasswordHash: "h", Role: "viewer"})

	body, _ := json.Marshal(map[string]any{"role": "superuser"})
	r := withURLParam(httptest.NewRequest(http.MethodPatch, "/x", bytes.NewReader(body)), "id", strconv.FormatInt(u.ID, 10))
	rec := httptest.NewRecorder()
	h.UpdateUser(rec, r)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unknown role status = %d, want 400", rec.Code)
	}
}

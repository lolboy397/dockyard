package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

// TestGitRepoTokenNotSerialized verifies the stored credential is never emitted
// to API clients, while has_token still signals its presence.
func TestGitRepoTokenNotSerialized(t *testing.T) {
	repo := storage.GitRepo{Name: "r", Token: "ghp_supersecret", HasToken: true}
	b, err := json.Marshal(repo)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if strings.Contains(s, "ghp_supersecret") || strings.Contains(s, `"token"`) {
		t.Errorf("token leaked into JSON: %s", s)
	}
	if !strings.Contains(s, `"has_token":true`) {
		t.Errorf("has_token missing from JSON: %s", s)
	}
}

func getEnvReq(role, stack string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/stacks/"+stack+"/env", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("name", stack)
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	if role != "" {
		u := &storage.User{Role: role, Active: true}
		r = r.WithContext(context.WithValue(r.Context(), userCtxKey, u))
	}
	return r
}

// TestGetEnvMasksSecretsForViewers verifies viewers receive secret values
// blanked while operators/admins receive the real values (so save round-trips).
func TestGetEnvMasksSecretsForViewers(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.SetStackEnv("web", []storage.StackEnvVar{
		{Key: "DB_PASS", Value: "s3cret", IsSecret: true},
		{Key: "HOST", Value: "db.local", IsSecret: false},
	}); err != nil {
		t.Fatal(err)
	}
	h := &StackHandlers{db: db}

	decode := func(role string) map[string]string {
		rec := httptest.NewRecorder()
		h.GetEnv(rec, getEnvReq(role, "web"))
		if rec.Code != http.StatusOK {
			t.Fatalf("role %q: status %d", role, rec.Code)
		}
		var vars []storage.StackEnvVar
		if err := json.Unmarshal(rec.Body.Bytes(), &vars); err != nil {
			t.Fatal(err)
		}
		m := map[string]string{}
		for _, v := range vars {
			m[v.Key] = v.Value
		}
		return m
	}

	viewer := decode("viewer")
	if viewer["DB_PASS"] != "" {
		t.Errorf("viewer saw secret value %q, want masked", viewer["DB_PASS"])
	}
	if viewer["HOST"] != "db.local" {
		t.Errorf("viewer non-secret value = %q, want db.local", viewer["HOST"])
	}

	operator := decode("operator")
	if operator["DB_PASS"] != "s3cret" {
		t.Errorf("operator secret value = %q, want s3cret (needed for edit round-trip)", operator["DB_PASS"])
	}
}

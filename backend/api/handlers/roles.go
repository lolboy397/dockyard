package handlers

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

// RoleHandlers serves the role catalogue backing the admin Roles screen.
type RoleHandlers struct {
	db *storage.DB
}

// NewRoleHandlers builds the role handler set.
func NewRoleHandlers(db *storage.DB) *RoleHandlers {
	return &RoleHandlers{db: db}
}

var roleSlugRe = regexp.MustCompile(`[^a-z0-9]+`)

// roleDetail is a role plus the accounts currently assigned to it.
type roleDetail struct {
	storage.Role
	MemberList []storage.User `json:"member_list"`
}

// List returns every role (system first, then custom) with live member counts.
func (h *RoleHandlers) List(w http.ResponseWriter, r *http.Request) {
	roles, err := h.db.ListRoles()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if roles == nil {
		roles = []storage.Role{}
	}
	writeJSON(w, roles)
}

// Capabilities returns the capability catalogue (groups + rows) and the set of
// assignable states, so the Roles screen and create-role modal can render the
// matrix without hard-coding it.
func (h *RoleHandlers) Capabilities(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"groups": storage.CapabilityGroups,
		"states": []map[string]string{
			{"value": storage.CapNone, "label": "none"},
			{"value": storage.CapRead, "label": "read"},
			{"value": storage.CapScoped, "label": "scoped"},
			{"value": storage.CapAll, "label": "full"},
		},
	})
}

// Get returns a single role with the list of members holding it.
func (h *RoleHandlers) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	role, err := h.db.GetRole(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if role == nil {
		writeError(w, http.StatusNotFound, errMsg("role not found"))
		return
	}
	members, err := h.db.ListUsersByRole(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if members == nil {
		members = []storage.User{}
	}
	writeJSON(w, roleDetail{Role: *role, MemberList: members})
}

type createRoleRequest struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Icon         string            `json:"icon"`
	Capabilities map[string]string `json:"capabilities"`
}

// Create adds a custom role. The id is slugged from the name; tier and access
// level are derived from the capabilities server-side.
func (h *RoleHandlers) Create(w http.ResponseWriter, r *http.Request) {
	var req createRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, errMsg("role name is required"))
		return
	}
	id := "custom_" + strings.Trim(roleSlugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if id == "custom_" {
		writeError(w, http.StatusBadRequest, errMsg("role name must contain letters or numbers"))
		return
	}
	if exists, _ := h.db.RoleExists(id); exists {
		writeError(w, http.StatusConflict, errMsg("a role with this name already exists"))
		return
	}
	desc := strings.TrimSpace(req.Description)
	if desc == "" {
		desc = "Custom role."
	}
	role, err := h.db.CreateRole(storage.Role{
		ID:           id,
		Name:         name,
		Description:  desc,
		Icon:         strings.TrimSpace(req.Icon),
		Capabilities: req.Capabilities,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, role)
}

// Delete removes a custom role (system roles and in-use roles are rejected).
func (h *RoleHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.db.DeleteRole(id); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

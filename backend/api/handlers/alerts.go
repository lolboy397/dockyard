package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"docker-manager/backend/storage"

	"github.com/go-chi/chi/v5"
)

// AlertHandlers manages alert-rule CRUD.
type AlertHandlers struct {
	db *storage.DB
}

func NewAlertHandlers(db *storage.DB) *AlertHandlers {
	return &AlertHandlers{db: db}
}

// validAlertType reports whether t is a rule type the engine can evaluate. It is
// the single gate Create/Update apply, so it MUST stay in sync with both the
// evalAlertRule switch (backend/alerts_eval.go) and the <option> list the Alerts
// UI offers (frontend/.../alerts.component.html) — a type offered by the dropdown
// but missing here is rejected with a 400 (see TestValidAlertTypeAcceptsEveryUIType).
func validAlertType(t string) bool {
	switch t {
	case "host_cpu", "host_mem", "host_disk", "container_exited", "new_issue", "error_rate":
		return true
	}
	return false
}

// List returns all alert rules.
func (h *AlertHandlers) List(w http.ResponseWriter, r *http.Request) {
	rules, err := h.db.ListAlertRules()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if rules == nil {
		rules = []storage.AlertRule{}
	}
	writeJSON(w, rules)
}

// Create adds an alert rule.
func (h *AlertHandlers) Create(w http.ResponseWriter, r *http.Request) {
	var a storage.AlertRule
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	if a.Name == "" || !validAlertType(a.Type) {
		writeError(w, http.StatusBadRequest, errMsg("name and a valid type (host_cpu|host_mem|host_disk|container_exited|new_issue|error_rate) are required"))
		return
	}
	if a.Channel == "" {
		a.Channel = "in_app"
	}
	created, err := h.db.CreateAlertRule(a)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, created)
}

// Update edits an alert rule.
func (h *AlertHandlers) Update(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}
	var a storage.AlertRule
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	if !validAlertType(a.Type) {
		writeError(w, http.StatusBadRequest, errMsg("invalid type"))
		return
	}
	a.ID = id
	if err := h.db.UpdateAlertRule(a); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, a)
}

// Delete removes an alert rule.
func (h *AlertHandlers) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid id"))
		return
	}
	if err := h.db.DeleteAlertRule(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

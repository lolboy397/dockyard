package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// ---- Roles & capabilities ---------------------------------------------------
//
// Dockyard's role model backs the admin Members/Roles screens. A role is a
// named bundle of capabilities. Six roles are seeded as `system` (immutable);
// admins may create additional `custom` roles. Environment-scoped access is
// deliberately NOT modelled yet — capabilities are global levels
// (all | scoped | read | none) only.

// Capability states, ordered weakest → strongest.
const (
	CapNone   = "none"
	CapRead   = "read"
	CapScoped = "scoped"
	CapAll    = "all"
)

// CapRowDef is one capability (a stable key + its human label).
type CapRowDef struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// CapGroupDef groups related capabilities for display in the matrix.
type CapGroupDef struct {
	Group string      `json:"group"`
	Rows  []CapRowDef `json:"rows"`
}

// CapabilityGroups is the canonical capability catalogue rendered by the Roles
// screen and the create-role modal. Keys are stable; labels are display-only.
var CapabilityGroups = []CapGroupDef{
	{Group: "Containers", Rows: []CapRowDef{
		{Key: "containers.view", Label: "View containers"},
		{Key: "logs.view", Label: "View container logs"},
		{Key: "containers.lifecycle", Label: "Start, stop, restart"},
		{Key: "containers.exec", Label: "Open shell / exec"},
		{Key: "containers.remove", Label: "Remove containers"},
	}},
	{Group: "Images & builds", Rows: []CapRowDef{
		{Key: "images.pull", Label: "Pull images"},
		{Key: "images.build", Label: "Build images"},
		{Key: "images.push", Label: "Push to registry"},
		{Key: "images.prune", Label: "Prune images"},
	}},
	{Group: "Infrastructure", Rows: []CapRowDef{
		{Key: "infra.volumes_networks", Label: "Volumes & networks"},
		{Key: "infra.prune", Label: "Prune resources"},
	}},
	{Group: "Deployments", Rows: []CapRowDef{
		{Key: "deploy.rollback", Label: "Deploy & rollback"},
	}},
	{Group: "Organization", Rows: []CapRowDef{
		{Key: "org.members", Label: "Invite & remove users"},
		{Key: "org.roles", Label: "Manage roles"},
		{Key: "org.tokens", Label: "API tokens & registries"},
	}},
}

// capabilityKeys returns every capability key in catalogue order.
func capabilityKeys() []string {
	keys := make([]string, 0, 16)
	for _, g := range CapabilityGroups {
		for _, r := range g.Rows {
			keys = append(keys, r.Key)
		}
	}
	return keys
}

// systemRoleSpec is the seed definition for a built-in role.
type systemRoleSpec struct {
	id    string
	name  string
	icon  string
	desc  string
	level string
	sort  int
	caps  map[string]string
}

// systemRoles defines the immutable built-in roles (minus environment scoping).
// Any capability key omitted defaults to "none".
var systemRoles = []systemRoleSpec{
	{
		id: "owner", name: "Owner", icon: "crown", sort: 1, level: "Full access",
		desc: "Full control of the organization and every environment.",
		caps: fillCaps(CapAll),
	},
	{
		id: "admin", name: "Admin", icon: "shield", sort: 2, level: "Manage + deploy",
		desc: "Manage users, roles, and infrastructure across assigned environments.",
		caps: fillCaps(CapAll),
	},
	{
		id: "maintainer", name: "Maintainer", icon: "wrench", sort: 3, level: "Operate + deploy",
		desc: "Deploy, start, stop, and prune resources. No user-management access.",
		caps: map[string]string{
			"containers.view": CapAll, "logs.view": CapAll, "containers.lifecycle": CapAll, "containers.exec": CapAll, "containers.remove": CapScoped,
			"images.pull": CapAll, "images.build": CapAll, "images.push": CapScoped, "images.prune": CapScoped,
			"infra.volumes_networks": CapScoped, "infra.prune": CapScoped,
			"deploy.rollback": CapScoped,
			"org.members":     CapNone, "org.roles": CapNone, "org.tokens": CapScoped,
		},
	},
	{
		id: "developer", name: "Developer", icon: "code", sort: 4, level: "Build + operate",
		desc: "Build images and manage containers in non-production environments.",
		caps: map[string]string{
			"containers.view": CapAll, "logs.view": CapAll, "containers.lifecycle": CapScoped, "containers.exec": CapScoped, "containers.remove": CapNone,
			"images.pull": CapScoped, "images.build": CapScoped, "images.push": CapNone, "images.prune": CapNone,
			"infra.volumes_networks": CapScoped, "infra.prune": CapNone,
			"deploy.rollback": CapScoped,
			"org.members":     CapNone, "org.roles": CapNone, "org.tokens": CapNone,
		},
	},
	{
		id: "viewer", name: "Viewer", icon: "eye", sort: 5, level: "Read-only",
		desc: "Read-only access to containers and images. Log content requires an operator role.",
		caps: map[string]string{
			"containers.view": CapRead, "logs.view": CapNone, "containers.lifecycle": CapNone, "containers.exec": CapNone, "containers.remove": CapNone,
			"images.pull": CapRead, "images.build": CapNone, "images.push": CapNone, "images.prune": CapNone,
			"infra.volumes_networks": CapRead, "infra.prune": CapNone,
			"deploy.rollback": CapNone,
			"org.members":     CapNone, "org.roles": CapNone, "org.tokens": CapNone,
		},
	},
}

func fillCaps(state string) map[string]string {
	out := make(map[string]string, 16)
	for _, k := range capabilityKeys() {
		out[k] = state
	}
	return out
}

func mergeCaps(base, over map[string]string) map[string]string {
	for k, v := range over {
		base[k] = v
	}
	return base
}

// Role is a named capability bundle assignable to a user.
type Role struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Icon         string            `json:"icon"`
	Type         string            `json:"type"` // system | custom
	Tier         string            `json:"tier"` // admin | operator | viewer (authorization)
	Level        string            `json:"level"`
	Capabilities map[string]string `json:"capabilities"`
	Sort         int               `json:"sort"`
	Members      int               `json:"members"`
	CreatedAt    time.Time         `json:"created_at"`
}

// migrateV19 creates the roles table and seeds the six system roles. Existing
// `operator` accounts are migrated to the closest system role (maintainer).
func (db *DB) migrateV19() error {
	if _, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS roles (
			id           TEXT PRIMARY KEY,
			name         TEXT NOT NULL,
			description  TEXT NOT NULL DEFAULT '',
			icon         TEXT NOT NULL DEFAULT 'shield',
			type         TEXT NOT NULL DEFAULT 'custom',
			tier         TEXT NOT NULL DEFAULT 'viewer',
			level        TEXT NOT NULL DEFAULT '',
			capabilities TEXT NOT NULL DEFAULT '{}',
			sort         INTEGER NOT NULL DEFAULT 100,
			created_at   DATETIME NOT NULL DEFAULT (datetime('now'))
		);
	`); err != nil {
		return err
	}

	for _, s := range systemRoles {
		capsJSON, err := json.Marshal(s.caps)
		if err != nil {
			return err
		}
		if _, err := db.conn.Exec(`
			INSERT INTO roles (id, name, description, icon, type, tier, level, capabilities, sort)
			VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				name=excluded.name, description=excluded.description, icon=excluded.icon,
				type='system', tier=excluded.tier, level=excluded.level,
				capabilities=excluded.capabilities, sort=excluded.sort
		`, s.id, s.name, s.desc, s.icon, tierForCaps(s.caps, s.id), s.level, string(capsJSON), s.sort); err != nil {
			return err
		}
	}

	// Migrate legacy operator accounts to the nearest system role so they map to a
	// real role row. operator ≈ maintainer (operate + deploy, no member mgmt).
	db.conn.Exec(`UPDATE users SET role='maintainer' WHERE role='operator'`) //nolint:errcheck

	// Billing is not a concept in this application: reassign any legacy billing
	// accounts to viewer (its former read-only tier) and drop the seeded role.
	db.conn.Exec(`UPDATE users SET role='viewer' WHERE role='billing'`) //nolint:errcheck
	db.conn.Exec(`DELETE FROM roles WHERE id='billing'`)                 //nolint:errcheck
	return nil
}

// tierForCaps derives the authorization tier from a capability map. The two
// built-in admin roles are pinned to the admin tier; everything else is derived.
func tierForCaps(caps map[string]string, id string) string {
	if id == "owner" || id == "admin" {
		return "admin"
	}
	granted := func(k string) bool { return caps[k] == CapAll || caps[k] == CapScoped }
	if granted("org.members") || granted("org.roles") {
		return "admin"
	}
	operateKeys := []string{
		"containers.lifecycle", "containers.exec", "containers.remove",
		"images.build", "images.push", "images.prune",
		"infra.volumes_networks", "infra.prune", "deploy.rollback", "org.tokens",
	}
	for _, k := range operateKeys {
		if granted(k) {
			return "operator"
		}
	}
	return "viewer"
}

// levelForCaps produces the short access-level label shown in the roles table,
// mirroring the mockup's levelOf() heuristic.
func levelForCaps(caps map[string]string) string {
	has := func(state string) bool {
		for _, k := range capabilityKeys() {
			if caps[k] == state {
				return true
			}
		}
		return false
	}
	if caps["org.roles"] == CapAll {
		return "Manage + deploy"
	}
	if caps["deploy.rollback"] == CapAll || caps["deploy.rollback"] == CapScoped {
		return "Operate + deploy"
	}
	if has(CapAll) || has(CapScoped) {
		return "Build + operate"
	}
	if has(CapRead) {
		return "Read-only"
	}
	return "No access"
}

func scanRole(s scanner, memberCount int) (*Role, error) {
	var r Role
	var capsJSON, ts string
	if err := s.Scan(&r.ID, &r.Name, &r.Description, &r.Icon, &r.Type, &r.Tier, &r.Level, &capsJSON, &r.Sort, &ts); err != nil {
		return nil, err
	}
	r.Capabilities = map[string]string{}
	_ = json.Unmarshal([]byte(capsJSON), &r.Capabilities)
	// Backfill any capability the stored map is missing so the frontend matrix is
	// always complete.
	for _, k := range capabilityKeys() {
		if _, ok := r.Capabilities[k]; !ok {
			r.Capabilities[k] = CapNone
		}
	}
	r.CreatedAt = parseDBTime(ts)
	r.Members = memberCount
	return &r, nil
}

const roleCols = `id, name, description, icon, type, tier, level, capabilities, sort, created_at`

// ListRoles returns all roles (system first, then custom) with live member counts.
func (db *DB) ListRoles() ([]Role, error) {
	counts, err := db.roleMemberCounts()
	if err != nil {
		return nil, err
	}
	rows, err := db.read.Query(`SELECT ` + roleCols + ` FROM roles ORDER BY type='custom', sort, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roles []Role
	for rows.Next() {
		r, err := scanRole(rows, 0)
		if err != nil {
			return nil, err
		}
		r.Members = counts[r.ID]
		roles = append(roles, *r)
	}
	return roles, rows.Err()
}

// GetRole returns a single role with its live member count, or nil if absent.
func (db *DB) GetRole(id string) (*Role, error) {
	row := db.read.QueryRow(`SELECT `+roleCols+` FROM roles WHERE id=?`, id)
	r, err := scanRole(row, 0)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	n, err := db.CountUsersByRole(id)
	if err != nil {
		return nil, err
	}
	r.Members = n
	return r, nil
}

// RoleExists reports whether a role id is defined (system or custom).
func (db *DB) RoleExists(id string) (bool, error) {
	var n int
	err := db.read.QueryRow(`SELECT COUNT(*) FROM roles WHERE id=?`, id).Scan(&n)
	return n > 0, err
}

// RoleTier returns the authorization tier (admin|operator|viewer) for a role id,
// defaulting to the least-privileged tier for unknown roles.
func (db *DB) RoleTier(id string) string {
	switch id { // legacy aliases that may linger before migration runs
	case "operator":
		return "operator"
	}
	var tier string
	if err := db.read.QueryRow(`SELECT tier FROM roles WHERE id=?`, id).Scan(&tier); err != nil {
		return "viewer"
	}
	return tier
}

// RoleGrantsLogView reports whether the role explicitly grants the logs.view
// capability (any level above none). It lets a non-operator custom role be granted
// log access WITHOUT raising its overall tier (logs.view is not in tierForCaps's
// operate set). Operator/admin tiers get logs regardless — this only ever expands
// access (see handlers.canViewLogs).
func (db *DB) RoleGrantsLogView(id string) bool {
	var capsJSON string
	if err := db.read.QueryRow(`SELECT capabilities FROM roles WHERE id=?`, id).Scan(&capsJSON); err != nil {
		return false
	}
	var caps map[string]string
	if json.Unmarshal([]byte(capsJSON), &caps) != nil {
		return false
	}
	v := caps["logs.view"]
	return v != "" && v != CapNone
}

// CreateRole inserts a custom role. tier and level are derived from caps.
func (db *DB) CreateRole(r Role) (*Role, error) {
	caps := map[string]string{}
	for _, k := range capabilityKeys() {
		if v, ok := r.Capabilities[k]; ok {
			caps[k] = v
		} else {
			caps[k] = CapNone
		}
	}
	capsJSON, err := json.Marshal(caps)
	if err != nil {
		return nil, err
	}
	icon := r.Icon
	if icon == "" {
		icon = "shield-check"
	}
	if _, err := db.conn.Exec(`
		INSERT INTO roles (id, name, description, icon, type, tier, level, capabilities, sort)
		VALUES (?, ?, ?, ?, 'custom', ?, ?, ?, 100)
	`, r.ID, r.Name, r.Description, icon, tierForCaps(caps, r.ID), levelForCaps(caps), string(capsJSON)); err != nil {
		return nil, err
	}
	return db.GetRole(r.ID)
}

// DeleteRole removes a custom role. System roles cannot be deleted, nor can a
// role that still has members assigned.
func (db *DB) DeleteRole(id string) error {
	role, err := db.GetRole(id)
	if err != nil {
		return err
	}
	if role == nil {
		return errors.New("role not found")
	}
	if role.Type == "system" {
		return errors.New("system roles cannot be deleted")
	}
	if role.Members > 0 {
		return errors.New("reassign members before deleting this role")
	}
	_, err = db.conn.Exec(`DELETE FROM roles WHERE id=? AND type='custom'`, id)
	return err
}

// CountUsersByRole returns the number of accounts holding a role.
func (db *DB) CountUsersByRole(role string) (int, error) {
	var n int
	err := db.read.QueryRow(`SELECT COUNT(*) FROM users WHERE role=?`, role).Scan(&n)
	return n, err
}

func (db *DB) roleMemberCounts() (map[string]int, error) {
	rows, err := db.read.Query(`SELECT role, COUNT(*) FROM users GROUP BY role`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var role string
		var n int
		if err := rows.Scan(&role, &n); err != nil {
			return nil, err
		}
		counts[role] = n
	}
	return counts, rows.Err()
}

// ListUsersByRole returns the accounts assigned a given role, id order.
func (db *DB) ListUsersByRole(role string) ([]User, error) {
	rows, err := db.read.Query(`SELECT `+userCols+` FROM users WHERE role=? ORDER BY id`, role)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, *u)
	}
	return users, rows.Err()
}

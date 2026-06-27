package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"docker-manager/backend/storage"

	dockercontainer "github.com/docker/docker/api/types/container"
	dockerimage "github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
)

// appVersion is the Dockyard application version surfaced on the auth screens.
const appVersion = "0.0.4"

// AuthHandlers serves the first-run setup wizard and login endpoints.
type AuthHandlers struct {
	db      *storage.DB
	docker  *client.Client
	limiter *loginLimiter
	sso     *ssoState // in-flight SSO logins + discovered-provider cache
}

// NewAuthHandlers builds the auth handler set.
func NewAuthHandlers(db *storage.DB, cli *client.Client) *AuthHandlers {
	return &AuthHandlers{db: db, docker: cli, limiter: newLoginLimiter(), sso: newSSOState()}
}

var emailRe = regexp.MustCompile(`^\S+@\S+\.\S+$`)

// publicPaths are the only endpoints reachable without a valid session: the
// health probe and the first-run/login bootstrap routes the auth screens need
// before a token exists.
var publicPaths = map[string]bool{
	"/health":                      true,
	"/api/v1/auth/status":          true,
	"/api/v1/auth/setup":           true,
	"/api/v1/auth/login":           true,
	"/api/v1/auth/test-connection": true,
	// SSO redirect + callback happen before a Dockyard session exists.
	"/api/v1/auth/sso/login":    true,
	"/api/v1/auth/sso/callback": true,
}

// RequireAuth is middleware that rejects requests lacking a valid session token.
// The token may be supplied as an "Authorization: Bearer <token>" header or as a
// "token" query parameter — the latter for WebSocket clients, which cannot set
// custom headers from the browser. Endpoints in publicPaths bypass the check.
func (h *AuthHandlers) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if publicPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		token := bearerToken(r)
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		user, err := h.db.GetSessionUser(token)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		if user == nil || !user.Active {
			writeError(w, http.StatusUnauthorized, errMsg("authentication required"))
			return
		}
		ctx := context.WithValue(r.Context(), userCtxKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ---- Role-based access, audit & login limiting ------------------------------

type ctxKey string

const userCtxKey ctxKey = "dy.user"

// UserFromContext returns the authenticated user attached by RequireAuth.
func UserFromContext(ctx context.Context) *storage.User {
	u, _ := ctx.Value(userCtxKey).(*storage.User)
	return u
}

func actorName(r *http.Request) string {
	if u := UserFromContext(r.Context()); u != nil {
		return u.Username
	}
	return "system"
}

// staticRoleTier maps the built-in (and legacy) roles to their authorization
// tier without a database lookup. It is the fallback when a user's Tier field
// is not pre-resolved (e.g. in unit tests); production requests carry a Tier
// populated by GetSessionUser, which also covers custom roles.
var staticRoleTier = map[string]string{
	"owner": "admin", "admin": "admin",
	"maintainer": "operator", "developer": "operator", "operator": "operator",
	"viewer": "viewer",
}

// userTier returns a user's authorization tier, preferring the pre-resolved
// Tier and falling back to the static role map.
func userTier(u *storage.User) string {
	if u == nil {
		return ""
	}
	if u.Tier != "" {
		return u.Tier
	}
	return staticRoleTier[u.Role]
}

// canWrite reports whether the request's authenticated user may perform
// mutating/operational actions (operator or admin tier). Used to gate endpoints
// — such as the WebSocket exec shell — that fall outside the method-based
// Authorize middleware.
func canWrite(r *http.Request) bool {
	t := userTier(UserFromContext(r.Context()))
	return t == "admin" || t == "operator"
}

// canViewLogs reports whether the request's user may read container/stack/project
// log CONTENT. Logs routinely carry secrets — connection strings, tokens printed
// at boot, request/response payloads, stack traces echoing env values — so log
// streams are intentionally held to a higher bar than container metadata: any
// viewer may see that a container exists and its state, but only operator+ tiers
// may read what it logs. Centralised here (rather than inlining the tier check)
// so the policy can later move to a dedicated capability without touching the six
// log handlers that call it. Currently equivalent to canWrite (operator|admin).
func canViewLogs(r *http.Request) bool {
	return canWrite(r)
}

// isAdmin reports whether the request's authenticated user holds the admin tier
// (owner/admin system roles, or a custom role granting member/role management).
func isAdmin(r *http.Request) bool {
	return userTier(UserFromContext(r.Context())) == "admin"
}

// isAdminPath flags routes restricted to the admin tier regardless of method
// (member and role administration).
func isAdminPath(p string) bool {
	return strings.HasPrefix(p, "/api/v1/users")
}

// isRoleMutation flags a write to the role catalogue, which is admin-only even
// though reading roles is allowed for any authenticated user.
func isRoleMutation(method, p string) bool {
	return isMutating(method) && strings.HasPrefix(p, "/api/v1/roles")
}

// isEventFilterMutation flags a write to the global event mute rules. These are
// shared across all users and hide entries from the audit feed, so changing them
// is admin-only even though reading them (and the events) is open to any user.
func isEventFilterMutation(method, p string) bool {
	return isMutating(method) && strings.HasPrefix(p, "/api/v1/events/filters")
}

func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// Authorize enforces roles: viewers are read-only, operators may act but not
// manage users, admins may do anything. Must run after RequireAuth.
func (h *AuthHandlers) Authorize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if publicPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		u := UserFromContext(r.Context())
		if u == nil {
			writeError(w, http.StatusUnauthorized, errMsg("authentication required"))
			return
		}
		tier := userTier(u)
		// Member administration (and role / event-filter mutations) require admin.
		if (isAdminPath(r.URL.Path) || isRoleMutation(r.Method, r.URL.Path) || isEventFilterMutation(r.Method, r.URL.Path)) && tier != "admin" {
			writeError(w, http.StatusForbidden, errMsg("admin role required"))
			return
		}
		// Self-service account-security endpoints (logout, managing one's own 2FA)
		// are allowed for any authenticated user, including viewers.
		if isMutating(r.Method) && r.URL.Path != "/api/v1/auth/logout" && !strings.HasPrefix(r.URL.Path, "/api/v1/auth/2fa") {
			if tier != "admin" && tier != "operator" {
				writeError(w, http.StatusForbidden, errMsg("insufficient permissions (operator role required)"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// statusWriter captures the response status for audit logging while passing
// Flush through so streaming handlers keep working.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// AuditMutations records successful mutating API requests against the acting
// user, turning the events feed into an accountability log. Runs after Authorize.
func (h *AuthHandlers) AuditMutations(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isMutating(r.Method) || publicPaths[r.URL.Path] || r.URL.Path == "/api/v1/auth/logout" {
			next.ServeHTTP(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status >= 200 && sw.status < 300 {
			resource := strings.TrimPrefix(r.URL.Path, "/api/v1/")
			_ = h.db.LogEvent("audit", actorName(r), "api", resource, "", "", r.Method+" "+r.URL.Path)
		}
	})
}

// ---- Login rate limiting ----------------------------------------------------

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]*attemptRecord
}

type attemptRecord struct {
	count       int
	lockedUntil time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{attempts: make(map[string]*attemptRecord)}
}

func (l *loginLimiter) blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec := l.attempts[key]
	return rec != nil && time.Now().Before(rec.lockedUntil)
}

func (l *loginLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	rec := l.attempts[key]
	if rec == nil {
		rec = &attemptRecord{}
		l.attempts[key] = rec
	}
	rec.count++
	if rec.count >= 5 {
		rec.lockedUntil = time.Now().Add(15 * time.Minute)
		rec.count = 0
	}
}

func (l *loginLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}

// ---- GET /auth/status -------------------------------------------------------

// Status reports whether first-run setup is complete plus the instance metadata
// the login screen and setup rail display (engine version, bind address, …).
func (h *AuthHandlers) Status(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.db.GetInstanceConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	complete, err := h.db.IsSetupComplete()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	engineVersion := ""
	if v, verr := h.docker.ServerVersion(r.Context()); verr == nil {
		engineVersion = v.Version
	}

	// Surface whether SSO is available (and its button label) so the login screen
	// can show the button before any session exists.
	ssoEnabled, ssoLabel := false, ""
	if oc, _ := h.db.GetOIDCConfig(); oc != nil && oc.Enabled && oc.IssuerURL != "" && oc.ClientID != "" {
		ssoEnabled, ssoLabel = true, oc.ButtonLabel
	}

	writeJSON(w, map[string]any{
		"setup_complete": complete,
		"instance_name":  cfg.InstanceName,
		"docker_host":    cfg.DockerHost,
		"bind_addr":      cfg.BindAddr,
		"registry":       cfg.Registry,
		"engine_version": engineVersion,
		"app_version":    appVersion,
		"sso_enabled":    ssoEnabled,
		"sso_label":      ssoLabel,
	})
}

// ---- POST /auth/setup -------------------------------------------------------

type setupRequest struct {
	FullName     string `json:"fullName"`
	Email        string `json:"email"`
	Username     string `json:"username"`
	Password     string `json:"password"`
	InstanceName string `json:"instanceName"`
	DockerHost   string `json:"dockerHost"`
	DataDir      string `json:"dataDir"`
	BindAddr     string `json:"bindAddr"`
	TLS          bool   `json:"tls"`
	AutoUpdate   bool   `json:"autoUpdate"`
	Telemetry    bool   `json:"telemetry"`
	Registry     string `json:"registry"`
}

// Setup creates the admin account and instance configuration. It is only valid
// before setup has been completed.
func (h *AuthHandlers) Setup(w http.ResponseWriter, r *http.Request) {
	complete, err := h.db.IsSetupComplete()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if complete {
		writeError(w, http.StatusConflict, errMsg("setup has already been completed"))
		return
	}

	var req setupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}

	req.FullName = strings.TrimSpace(req.FullName)
	req.Email = strings.TrimSpace(req.Email)
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))

	if req.FullName == "" {
		writeError(w, http.StatusBadRequest, errMsg("full name is required"))
		return
	}
	if !emailRe.MatchString(req.Email) {
		writeError(w, http.StatusBadRequest, errMsg("a valid email is required"))
		return
	}
	if len(req.Username) < 3 {
		writeError(w, http.StatusBadRequest, errMsg("username must be at least 3 characters"))
		return
	}
	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, errMsg("password must be at least 8 characters"))
		return
	}

	hash, err := hashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	user, err := h.db.CreateUser(storage.User{
		FullName:     req.FullName,
		Email:        req.Email,
		Username:     req.Username,
		PasswordHash: hash,
		Role:         "admin",
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	cfg := storage.DefaultInstanceConfig()
	cfg.InstanceName = firstNonEmpty(strings.TrimSpace(req.InstanceName), cfg.InstanceName)
	cfg.DockerHost = firstNonEmpty(strings.TrimSpace(req.DockerHost), cfg.DockerHost)
	cfg.DataDir = firstNonEmpty(strings.TrimSpace(req.DataDir), cfg.DataDir)
	cfg.BindAddr = firstNonEmpty(strings.TrimSpace(req.BindAddr), cfg.BindAddr)
	cfg.Registry = firstNonEmpty(strings.TrimSpace(req.Registry), cfg.Registry)
	cfg.TLS = req.TLS
	cfg.AutoUpdate = req.AutoUpdate
	cfg.Telemetry = req.Telemetry
	cfg.SetupComplete = true
	if err := h.db.SaveInstanceConfig(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	token, expires, err := h.issueSession(r, user.ID, false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	w.WriteHeader(http.StatusCreated)
	writeJSON(w, map[string]any{
		"token":      token,
		"expires_at": expires,
		"user":       user,
	})
}

// ---- POST /auth/login -------------------------------------------------------

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Remember bool   `json:"remember"`
	OTP      string `json:"otp"` // second-factor code (TOTP or backup), when 2FA is on
}

// Login validates credentials and issues a session token.
func (h *AuthHandlers) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}

	username := strings.ToLower(strings.TrimSpace(req.Username))
	if h.limiter.blocked(username) {
		writeError(w, http.StatusTooManyRequests, errMsg("too many failed attempts — try again in a few minutes"))
		return
	}

	user, err := h.db.GetUserByUsername(username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if user == nil || !user.Active || !verifyPassword(req.Password, user.PasswordHash) {
		h.limiter.fail(username)
		writeError(w, http.StatusUnauthorized, errMsg("Invalid username or password."))
		return
	}

	// Password is correct. If the account has two-factor enabled, require a valid
	// TOTP (or single-use backup) code before issuing a session.
	if user.TwoFactor {
		if strings.TrimSpace(req.OTP) == "" {
			// Signal the second step WITHOUT resetting the limiter or issuing a
			// token — the client re-submits username + password + otp.
			writeJSON(w, map[string]any{"two_factor_required": true})
			return
		}
		if !h.verifyUserOTP(user.ID, req.OTP) {
			h.limiter.fail(username)
			writeError(w, http.StatusUnauthorized, errMsg("Invalid authentication code."))
			return
		}
	}

	h.limiter.reset(username)

	token, expires, err := h.issueSession(r, user.ID, req.Remember)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, map[string]any{
		"token":      token,
		"expires_at": expires,
		"user":       user,
	})
}

// ---- GET /auth/me -----------------------------------------------------------

// Me returns the currently authenticated user for a bearer token.
func (h *AuthHandlers) Me(w http.ResponseWriter, r *http.Request) {
	user, err := h.db.GetSessionUser(bearerToken(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if user == nil {
		writeError(w, http.StatusUnauthorized, errMsg("not authenticated"))
		return
	}
	writeJSON(w, user)
}

// ---- POST /auth/logout ------------------------------------------------------

// Logout invalidates the current session token.
func (h *AuthHandlers) Logout(w http.ResponseWriter, r *http.Request) {
	if token := bearerToken(r); token != "" {
		_ = h.db.DeleteSession(token)
	}
	writeJSON(w, map[string]any{"ok": true})
}

// ---- User management (admin only) -------------------------------------------

func validRole(role string) bool {
	switch role {
	case "admin", "operator", "viewer":
		return true
	}
	return false
}

type createUserRequest struct {
	FullName string `json:"fullName"`
	Email    string `json:"email"`
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

// ListUsers returns all accounts.
func (h *AuthHandlers) ListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.db.ListUsers()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if users == nil {
		users = []storage.User{}
	}
	writeJSON(w, users)
}

// CreateUser creates an additional account.
func (h *AuthHandlers) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req createUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	req.FullName = strings.TrimSpace(req.FullName)
	req.Email = strings.TrimSpace(req.Email)
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	if req.FullName == "" {
		writeError(w, http.StatusBadRequest, errMsg("full name is required"))
		return
	}
	if !emailRe.MatchString(req.Email) {
		writeError(w, http.StatusBadRequest, errMsg("a valid email is required"))
		return
	}
	if len(req.Username) < 3 {
		writeError(w, http.StatusBadRequest, errMsg("username must be at least 3 characters"))
		return
	}
	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, errMsg("password must be at least 8 characters"))
		return
	}
	role := req.Role
	if role == "" {
		role = "viewer"
	}
	if ok, _ := h.db.RoleExists(role); !ok {
		writeError(w, http.StatusBadRequest, errMsg("unknown role"))
		return
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	user, err := h.db.CreateUser(storage.User{
		FullName:     req.FullName,
		Email:        req.Email,
		Username:     req.Username,
		PasswordHash: hash,
		Role:         role,
		Status:       "active",
		AuthMethod:   "password",
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, user)
}

type updateUserRequest struct {
	FullName  *string `json:"fullName"`
	Email     *string `json:"email"`
	Role      *string `json:"role"`
	Status    *string `json:"status"`    // active | suspended | invited
	TwoFactor *bool   `json:"twoFactor"` // 2FA required/enabled
	Active    *bool   `json:"active"`    // legacy flag (kept in sync with status)
	Password  *string `json:"password"`
}

func validStatus(s string) bool {
	switch s {
	case "active", "suspended", "invited":
		return true
	}
	return false
}

// UpdateUser edits an account and optionally resets its password. Protects the
// last admin-tier account from demotion/deactivation.
func (h *AuthHandlers) UpdateUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid user id"))
		return
	}
	user, err := h.db.GetUserByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("user not found"))
		return
	}
	var req updateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}

	// Validate the target role up-front so the last-admin guard sees the new tier.
	if req.Role != nil {
		if ok, _ := h.db.RoleExists(*req.Role); !ok {
			writeError(w, http.StatusBadRequest, errMsg("unknown role"))
			return
		}
	}
	if req.Status != nil && !validStatus(*req.Status) {
		writeError(w, http.StatusBadRequest, errMsg("status must be active, suspended or invited"))
		return
	}

	willDemote := req.Role != nil && h.db.RoleTier(*req.Role) != "admin"
	willDisable := (req.Status != nil && *req.Status != "active") || (req.Active != nil && !*req.Active)
	if h.db.RoleTier(user.Role) == "admin" && (willDemote || willDisable) {
		if admins, _ := h.db.CountAdmins(); admins <= 1 {
			writeError(w, http.StatusBadRequest, errMsg("cannot demote or deactivate the last admin"))
			return
		}
	}

	if req.FullName != nil {
		user.FullName = strings.TrimSpace(*req.FullName)
	}
	if req.Email != nil {
		user.Email = strings.TrimSpace(*req.Email)
	}
	if req.Role != nil {
		user.Role = *req.Role
	}
	if req.TwoFactor != nil {
		// 2FA can only be enabled by the user themselves (they must enroll a TOTP
		// secret). Admins may turn it OFF as a reset/recovery, which also wipes the
		// stored secret + backup codes.
		if *req.TwoFactor {
			writeError(w, http.StatusBadRequest, errMsg("two-factor must be enabled by the user from their own account"))
			return
		}
		if err := h.db.DisableTOTP(id); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		user.TwoFactor = false
	}
	// Status is the canonical state; the legacy active flag mirrors it (active ⇔
	// status == active). Accept either, preferring an explicit status.
	if req.Status != nil {
		user.Status = *req.Status
		user.Active = *req.Status == "active"
	} else if req.Active != nil {
		user.Active = *req.Active
		if *req.Active {
			user.Status = "active"
		} else {
			user.Status = "suspended"
		}
	}
	if err := h.db.UpdateUser(*user); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if req.Password != nil && *req.Password != "" {
		if len(*req.Password) < 8 {
			writeError(w, http.StatusBadRequest, errMsg("password must be at least 8 characters"))
			return
		}
		hash, herr := hashPassword(*req.Password)
		if herr != nil {
			writeError(w, http.StatusInternalServerError, herr)
			return
		}
		if err := h.db.SetUserPassword(id, hash); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		// Revoke existing sessions so a pre-reset bearer token cannot keep
		// working after a password change (incident-response containment).
		if err := h.db.DeleteSessionsForUser(id); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
	}
	updated, _ := h.db.GetUserByID(id)
	writeJSON(w, updated)
}

// DeleteUser removes an account. Protects the last admin and self-deletion.
func (h *AuthHandlers) DeleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid user id"))
		return
	}
	if me := UserFromContext(r.Context()); me != nil && me.ID == id {
		writeError(w, http.StatusBadRequest, errMsg("you cannot delete your own account"))
		return
	}
	user, err := h.db.GetUserByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("user not found"))
		return
	}
	if h.db.RoleTier(user.Role) == "admin" {
		if admins, _ := h.db.CountAdmins(); admins <= 1 {
			writeError(w, http.StatusBadRequest, errMsg("cannot delete the last admin"))
			return
		}
	}
	if err := h.db.DeleteUser(id); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// UserActivity returns the recent audit events attributed to a member, backing
// the member-detail Activity tab. Admin-only (enforced by Authorize).
func (h *AuthHandlers) UserActivity(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid user id"))
		return
	}
	user, err := h.db.GetUserByID(id)
	if err != nil || user == nil {
		writeError(w, http.StatusNotFound, errMsg("user not found"))
		return
	}
	events, err := h.db.EventsByActor(user.Username, 30)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if events == nil {
		events = []storage.Event{}
	}
	writeJSON(w, events)
}

// UserSessions returns a member's active sign-in sessions, backing the
// member-detail Sessions tab. Admin-only (enforced by Authorize).
func (h *AuthHandlers) UserSessions(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid user id"))
		return
	}
	if user, uerr := h.db.GetUserByID(id); uerr != nil || user == nil {
		writeError(w, http.StatusNotFound, errMsg("user not found"))
		return
	}
	sessions, err := h.db.ListSessionsForUser(id, bearerToken(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if sessions == nil {
		sessions = []storage.Session{}
	}
	writeJSON(w, sessions)
}

// RevokeUserSessions signs a member out of all sessions except the caller's
// current one (so an admin revoking their own other sessions stays signed in;
// revoking another member's sessions signs them out entirely). Admin-only.
func (h *AuthHandlers) RevokeUserSessions(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid user id"))
		return
	}
	if user, uerr := h.db.GetUserByID(id); uerr != nil || user == nil {
		writeError(w, http.StatusNotFound, errMsg("user not found"))
		return
	}
	revoked, err := h.db.RevokeUserSessionsExcept(id, bearerToken(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"revoked": revoked})
}

// ---- POST /auth/test-connection ---------------------------------------------

// TestConnection pings the Docker engine and reports live container/image
// counts, backing the "Test connection" button on the instance setup step.
func (h *AuthHandlers) TestConnection(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if _, err := h.docker.Ping(ctx); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	containers, err := h.docker.ContainerList(ctx, dockercontainer.ListOptions{All: true})
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	images, err := h.docker.ImageList(ctx, dockerimage.ListOptions{All: false})
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	engineVersion := ""
	if v, verr := h.docker.ServerVersion(ctx); verr == nil {
		engineVersion = v.Version
	}

	writeJSON(w, map[string]any{
		"ok":             true,
		"containers":     len(containers),
		"images":         len(images),
		"engine_version": engineVersion,
	})
}

// ---- session + password helpers ---------------------------------------------

func (h *AuthHandlers) issueSession(r *http.Request, userID int64, remember bool) (string, time.Time, error) {
	ttl := 24 * time.Hour
	if remember {
		ttl = 30 * 24 * time.Hour
	}
	token, err := newToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expires, err := h.db.CreateSession(token, userID, ttl, r.UserAgent(), clientIP(r))
	if err != nil {
		return "", time.Time{}, err
	}
	// Stamp last-active on sign-in so a brand-new account reads "active now".
	_ = h.db.TouchLastActive(userID)
	return token, expires, nil
}

// clientIP extracts the originating client IP, honouring a single proxy hop via
// X-Forwarded-For / X-Real-IP before falling back to the socket address.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
		return xr
	}
	host := r.RemoteAddr
	if i := strings.LastIndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	return host
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return strings.TrimSpace(h)
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func firstNonEmpty(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

const (
	pbkdfIterations = 100000
	pbkdfKeyLen     = 32
)

// hashPassword returns a self-describing PBKDF2-HMAC-SHA256 hash string:
//
//	pbkdf2_sha256$<iterations>$<base64 salt>$<base64 derived key>
func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk := pbkdf2Key([]byte(pw), salt, pbkdfIterations, pbkdfKeyLen)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s",
		pbkdfIterations,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(dk),
	), nil
}

// verifyPassword checks a plaintext password against an encoded hash string in
// constant time.
func verifyPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2_sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got := pbkdf2Key([]byte(pw), salt, iter, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// pbkdf2Key is a stdlib-only PBKDF2-HMAC-SHA256 implementation (RFC 2898).
func pbkdf2Key(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	numBlocks := (keyLen + hashLen - 1) / hashLen

	dk := make([]byte, 0, numBlocks*hashLen)
	buf := make([]byte, 4)
	for block := 1; block <= numBlocks; block++ {
		prf.Reset()
		prf.Write(salt)
		buf[0] = byte(block >> 24)
		buf[1] = byte(block >> 16)
		buf[2] = byte(block >> 8)
		buf[3] = byte(block)
		prf.Write(buf)
		u := prf.Sum(nil)

		t := make([]byte, hashLen)
		copy(t, u)
		for n := 2; n <= iter; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(nil)
			for x := range t {
				t[x] ^= u[x]
			}
		}
		dk = append(dk, t...)
	}
	return dk[:keyLen]
}

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"docker-manager/backend/storage"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ---- SSO (OpenID Connect) ---------------------------------------------------
//
// A confidential-client Authorization Code flow with PKCE + nonce. The IdP is
// admin-configured (single provider). On callback we validate the ID token
// (signature via the provider's JWKS, iss/aud/exp, and nonce), then link the
// verified email to a local account (provisioning one when enabled) and issue a
// normal Dockyard session.

// ssoFlow is the transient per-login state, looked up by the opaque `state`.
type ssoFlow struct {
	nonce    string
	verifier string // PKCE code verifier
	expires  time.Time
}

// ssoState holds in-flight login state and a cache of discovered providers. Kept
// here (not in AuthHandlers) so auth.go need not import the OIDC library.
type ssoState struct {
	mu     sync.Mutex
	flows  map[string]ssoFlow
	provMu sync.Mutex
	provs  map[string]*oidc.Provider
}

func newSSOState() *ssoState {
	return &ssoState{flows: map[string]ssoFlow{}, provs: map[string]*oidc.Provider{}}
}

func (s *ssoState) put(state string, f ssoFlow) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, v := range s.flows { // opportunistic GC of expired entries
		if now.After(v.expires) {
			delete(s.flows, k)
		}
	}
	s.flows[state] = f
}

// take returns and removes a flow (single-use), rejecting expired ones.
func (s *ssoState) take(state string) (ssoFlow, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.flows[state]
	if ok {
		delete(s.flows, state)
	}
	if !ok || time.Now().After(f.expires) {
		return ssoFlow{}, false
	}
	return f, true
}

// provider returns a cached OIDC provider for an issuer, running discovery once.
func (s *ssoState) provider(ctx context.Context, issuer string) (*oidc.Provider, error) {
	s.provMu.Lock()
	defer s.provMu.Unlock()
	if p, ok := s.provs[issuer]; ok {
		return p, nil
	}
	p, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, err
	}
	s.provs[issuer] = p
	return p, nil
}

func (s *ssoState) clearProviders() {
	s.provMu.Lock()
	defer s.provMu.Unlock()
	s.provs = map[string]*oidc.Provider{}
}

// ssoRedirectURL is the callback URL registered at the IdP, derived from the
// request and honouring a single reverse-proxy hop.
func ssoRedirectURL(r *http.Request) string {
	scheme := "https"
	if xf := r.Header.Get("X-Forwarded-Proto"); xf != "" {
		scheme = strings.TrimSpace(strings.Split(xf, ",")[0])
	} else if r.TLS == nil {
		scheme = "http"
	}
	host := r.Host
	if xh := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); xh != "" {
		host = strings.Split(xh, ",")[0]
	}
	return scheme + "://" + host + "/api/v1/auth/sso/callback"
}

func oauth2Config(p *oidc.Provider, cfg *storage.OIDCConfig, redirectURL string) oauth2.Config {
	return oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		Endpoint:     p.Endpoint(),
		RedirectURL:  redirectURL,
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
}

// ssoFail redirects back to the SPA with an error code it can surface on login.
func ssoFail(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, "/?sso_error="+url.QueryEscape(code), http.StatusFound)
}

// SSOLogin begins the auth-code flow: store state/nonce/PKCE and redirect to the
// provider. GET /auth/sso/login (public).
func (h *AuthHandlers) SSOLogin(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.db.GetOIDCConfig()
	if err != nil || cfg == nil || !cfg.Enabled || cfg.IssuerURL == "" || cfg.ClientID == "" {
		ssoFail(w, r, "disabled")
		return
	}
	prov, err := h.sso.provider(r.Context(), cfg.IssuerURL)
	if err != nil {
		ssoFail(w, r, "provider")
		return
	}
	state, err1 := newToken()
	nonce, err2 := newToken()
	if err1 != nil || err2 != nil {
		ssoFail(w, r, "state")
		return
	}
	verifier := oauth2.GenerateVerifier()
	h.sso.put(state, ssoFlow{nonce: nonce, verifier: verifier, expires: time.Now().Add(5 * time.Minute)})

	oc := oauth2Config(prov, cfg, ssoRedirectURL(r))
	authURL := oc.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier), oauth2.AccessTypeOnline)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// SSOCallback completes the flow: validate state, exchange the code, verify the
// ID token + nonce, provision/link the user, and hand a session to the SPA.
// GET /auth/sso/callback (public).
func (h *AuthHandlers) SSOCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		ssoFail(w, r, e)
		return
	}
	flow, ok := h.sso.take(q.Get("state"))
	if !ok {
		ssoFail(w, r, "state")
		return
	}
	cfg, err := h.db.GetOIDCConfig()
	if err != nil || cfg == nil || !cfg.Enabled {
		ssoFail(w, r, "disabled")
		return
	}
	ctx := r.Context()
	prov, err := h.sso.provider(ctx, cfg.IssuerURL)
	if err != nil {
		ssoFail(w, r, "provider")
		return
	}
	oc := oauth2Config(prov, cfg, ssoRedirectURL(r))
	tok, err := oc.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(flow.verifier))
	if err != nil {
		ssoFail(w, r, "exchange")
		return
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		ssoFail(w, r, "no_id_token")
		return
	}
	idToken, err := prov.Verifier(&oidc.Config{ClientID: cfg.ClientID}).Verify(ctx, rawID)
	if err != nil {
		ssoFail(w, r, "verify")
		return
	}
	if idToken.Nonce != flow.nonce {
		ssoFail(w, r, "nonce")
		return
	}
	var claims struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil || strings.TrimSpace(claims.Email) == "" {
		ssoFail(w, r, "claims")
		return
	}

	user, err := h.provisionSSOUser(cfg, claims.Email, claims.Name)
	if err != nil {
		ssoFail(w, r, err.Error())
		return
	}
	token, _, err := h.issueSession(r, user.ID, true)
	if err != nil {
		ssoFail(w, r, "session")
		return
	}
	_ = h.db.TouchLastActive(user.ID)
	// Hand the session token to the SPA via the URL fragment (fragments aren't sent
	// to servers and the client strips it immediately), which then bootstraps in.
	http.Redirect(w, r, "/?sso=1#token="+url.QueryEscape(token), http.StatusFound)
}

// provisionSSOUser links a verified SSO email to an account, creating one when
// auto-provisioning is on. Returns a coded error (shown on the login screen).
func (h *AuthHandlers) provisionSSOUser(cfg *storage.OIDCConfig, email, name string) (*storage.User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if doms := strings.TrimSpace(cfg.AllowedDomains); doms != "" {
		dom := ""
		if at := strings.LastIndexByte(email, '@'); at >= 0 {
			dom = email[at+1:]
		}
		allowed := false
		for _, d := range strings.Split(doms, ",") {
			if strings.EqualFold(strings.TrimSpace(d), dom) {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, fmt.Errorf("domain_not_allowed")
		}
	}

	u, err := h.db.GetUserByEmail(email)
	if err != nil {
		return nil, fmt.Errorf("lookup_failed")
	}
	if u != nil {
		if !u.Active {
			return nil, fmt.Errorf("account_suspended")
		}
		return u, nil
	}
	if !cfg.AutoProvision {
		return nil, fmt.Errorf("no_account")
	}

	role := cfg.DefaultRole
	if ok, _ := h.db.RoleExists(role); !ok {
		role = "viewer"
	}
	pw, err := newToken() // unguessable; SSO users don't log in with a password
	if err != nil {
		return nil, fmt.Errorf("provision_failed")
	}
	hash, err := hashPassword(pw)
	if err != nil {
		return nil, fmt.Errorf("provision_failed")
	}
	username := h.uniqueUsername(email)
	created, err := h.db.CreateUser(storage.User{
		FullName:     firstNonEmpty(strings.TrimSpace(name), username),
		Email:        email,
		Username:     username,
		PasswordHash: hash,
		Role:         role,
		Status:       "active",
		AuthMethod:   "sso",
	})
	if err != nil {
		return nil, fmt.Errorf("provision_failed")
	}
	return created, nil
}

// uniqueUsername derives an available username from an email local-part.
func (h *AuthHandlers) uniqueUsername(email string) string {
	base := email
	if at := strings.IndexByte(email, '@'); at > 0 {
		base = email[:at]
	}
	base = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + 32
		default:
			return -1
		}
	}, base)
	if len(base) < 3 {
		base = "sso-" + base
	}
	name := base
	for i := 1; i <= 1000; i++ {
		if u, _ := h.db.GetUserByUsername(name); u == nil {
			return name
		}
		name = fmt.Sprintf("%s%d", base, i)
	}
	return name
}

// SSOConfigGet returns the SSO config (secret stripped). Admin-only.
func (h *AuthHandlers) SSOConfigGet(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	cfg, err := h.db.GetOIDCConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	cfg.ClientSecret = "" // never expose the secret to the client
	writeJSON(w, cfg)
}

// SSOConfigPut saves the SSO config. Admin-only. A blank client_secret keeps the
// stored one (so the form needn't re-enter it on every edit).
func (h *AuthHandlers) SSOConfigPut(w http.ResponseWriter, r *http.Request) {
	if !isAdmin(r) {
		writeError(w, http.StatusForbidden, errMsg("admin role required"))
		return
	}
	var req storage.OIDCConfig
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	if strings.TrimSpace(req.ClientSecret) == "" {
		if cur, _ := h.db.GetOIDCConfig(); cur != nil {
			req.ClientSecret = cur.ClientSecret
		}
	}
	if req.Enabled && (strings.TrimSpace(req.IssuerURL) == "" || strings.TrimSpace(req.ClientID) == "" || strings.TrimSpace(req.ClientSecret) == "") {
		writeError(w, http.StatusBadRequest, errMsg("issuer URL, client ID and client secret are required to enable SSO"))
		return
	}
	if err := h.db.SaveOIDCConfig(req); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	h.sso.clearProviders() // a changed issuer must re-run discovery
	cfg, _ := h.db.GetOIDCConfig()
	if cfg != nil {
		cfg.ClientSecret = ""
	}
	writeJSON(w, cfg)
}

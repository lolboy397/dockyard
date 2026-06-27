package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Two-factor (TOTP) self-service endpoints. All operate on the CURRENT user from
// the request context — any authenticated user may manage their own 2FA (the
// Authorize middleware exempts /auth/2fa from the operator-only mutation gate).

// verifyUserOTP validates a submitted second-factor code: first as a TOTP code,
// then (failing that) as a single-use backup code, which is consumed on success.
func (h *AuthHandlers) verifyUserOTP(userID int64, otp string) bool {
	secret, enabled, err := h.db.GetTOTPSecret(userID)
	if err != nil || !enabled || secret == "" {
		return false
	}
	otp = strings.TrimSpace(otp)
	if len(otp) == totpDigits && verifyTOTP(secret, otp, time.Now()) {
		return true
	}
	ok, _ := h.db.ConsumeBackupCode(userID, hashBackupCode(otp))
	return ok
}

// twoFactorIssuer is the label authenticator apps display for the account.
func (h *AuthHandlers) twoFactorIssuer() string {
	issuer := "Dockyard"
	if cfg, _ := h.db.GetInstanceConfig(); cfg != nil && strings.TrimSpace(cfg.InstanceName) != "" {
		issuer = "Dockyard · " + cfg.InstanceName
	}
	return issuer
}

// TwoFactorStatus reports the current user's 2FA state. GET /auth/2fa.
func (h *AuthHandlers) TwoFactorStatus(w http.ResponseWriter, r *http.Request) {
	u := UserFromContext(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, errMsg("authentication required"))
		return
	}
	secret, enabled, _ := h.db.GetTOTPSecret(u.ID)
	remaining, _ := h.db.BackupCodesRemaining(u.ID)
	writeJSON(w, map[string]any{
		"enabled":                enabled,
		"pending":                !enabled && secret != "",
		"backup_codes_remaining": remaining,
	})
}

// TwoFactorSetup generates a fresh (pending) TOTP secret for the current user and
// returns it plus the otpauth URI for QR provisioning. POST /auth/2fa/setup.
func (h *AuthHandlers) TwoFactorSetup(w http.ResponseWriter, r *http.Request) {
	u := UserFromContext(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, errMsg("authentication required"))
		return
	}
	if u.TwoFactor {
		writeError(w, http.StatusConflict, errMsg("two-factor is already enabled — disable it first to re-enroll"))
		return
	}
	secret, err := generateTOTPSecret()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := h.db.SetTOTPSecret(u.ID, secret); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{
		"secret":      secret,
		"otpauth_url": otpauthURL(h.twoFactorIssuer(), u.Username, secret),
	})
}

// TwoFactorConfirm verifies the first code against the pending secret, enables
// 2FA, and returns one-time backup codes (shown once). POST /auth/2fa/confirm.
func (h *AuthHandlers) TwoFactorConfirm(w http.ResponseWriter, r *http.Request) {
	u := UserFromContext(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, errMsg("authentication required"))
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	secret, enabled, err := h.db.GetTOTPSecret(u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if secret == "" {
		writeError(w, http.StatusBadRequest, errMsg("start two-factor setup first"))
		return
	}
	if enabled {
		writeError(w, http.StatusConflict, errMsg("two-factor is already enabled"))
		return
	}
	if !verifyTOTP(secret, strings.TrimSpace(req.Code), time.Now()) {
		writeError(w, http.StatusBadRequest, errMsg("that code didn't match — check your authenticator app and try again"))
		return
	}
	codes, err := generateBackupCodes(10)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	hashes := make([]string, len(codes))
	for i, c := range codes {
		hashes[i] = hashBackupCode(c)
	}
	if err := h.db.EnableTOTP(u.ID, hashes); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"enabled": true, "backup_codes": codes})
}

// TwoFactorDisable turns off 2FA for the current user after they re-confirm their
// password (so a hijacked session can't silently weaken the account).
// POST /auth/2fa/disable.
func (h *AuthHandlers) TwoFactorDisable(w http.ResponseWriter, r *http.Request) {
	u := UserFromContext(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, errMsg("authentication required"))
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid request body"))
		return
	}
	full, err := h.db.GetUserByID(u.ID)
	if err != nil || full == nil {
		writeError(w, http.StatusInternalServerError, errMsg("could not load account"))
		return
	}
	if !verifyPassword(req.Password, full.PasswordHash) {
		writeError(w, http.StatusForbidden, errMsg("password is incorrect"))
		return
	}
	if err := h.db.DisableTOTP(u.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"enabled": false})
}

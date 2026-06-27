package handlers

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP mandates HMAC-SHA1 for authenticator-app compatibility
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Two-factor auth uses TOTP (RFC 6238): HMAC-SHA1, 30-second period, 6 digits —
// the de-facto standard understood by Google Authenticator, Authy, 1Password, etc.
// Implemented with the standard library only, matching the project's hand-rolled
// PBKDF2 approach (no third-party crypto dependency).
const (
	totpPeriod = 30
	totpDigits = 6
)

var totpB32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// generateTOTPSecret returns a fresh 160-bit secret as an unpadded base32 string
// (the format authenticator apps expect).
func generateTOTPSecret() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return totpB32.EncodeToString(b), nil
}

// totpAt computes the RFC 6238 code for a base32 secret at time t.
func totpAt(secret string, t time.Time) (string, error) {
	key, err := totpB32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", err
	}
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(t.Unix())/totpPeriod)
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	// Dynamic truncation (RFC 4226 §5.3).
	off := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[off]&0x7f) << 24) | (uint32(sum[off+1]) << 16) | (uint32(sum[off+2]) << 8) | uint32(sum[off+3])
	return fmt.Sprintf("%0*d", totpDigits, code%1_000_000), nil
}

// verifyTOTP checks a submitted code against the secret, allowing ±1 period of
// clock skew. The comparison is constant-time.
func verifyTOTP(secret, code string, now time.Time) bool {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return false
	}
	for _, skew := range []time.Duration{0, -totpPeriod * time.Second, totpPeriod * time.Second} {
		want, err := totpAt(secret, now.Add(skew))
		if err != nil {
			return false
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

// otpauthURL builds the otpauth:// provisioning URI an authenticator app reads
// from the enrollment QR code.
func otpauthURL(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// generateBackupCodes returns n human-friendly one-time recovery codes
// (xxxxx-xxxxx). Show them once at enrollment; only their hashes are stored.
func generateBackupCodes(n int) ([]string, error) {
	codes := make([]string, 0, n)
	for i := 0; i < n; i++ {
		b := make([]byte, 5)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		h := hex.EncodeToString(b) // 10 hex chars
		codes = append(codes, h[:5]+"-"+h[5:])
	}
	return codes, nil
}

// hashBackupCode normalises a backup code (lower-case, dashes stripped) and
// returns its SHA-256 hex digest — the form stored and compared at login.
func hashBackupCode(code string) string {
	norm := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}

package handlers

import (
	"strings"
	"testing"
	"time"
)

// rfcSecret is the RFC 6238 SHA-1 test seed ("12345678901234567890") in base32.
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

// TestTOTPVectors checks totpAt against the published RFC 6238 test vectors
// (truncated to 6 digits).
func TestTOTPVectors(t *testing.T) {
	cases := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	}
	for _, c := range cases {
		got, err := totpAt(rfcSecret, time.Unix(c.unix, 0))
		if err != nil {
			t.Fatalf("totpAt(%d) error: %v", c.unix, err)
		}
		if got != c.want {
			t.Errorf("totpAt(%d) = %q, want %q", c.unix, got, c.want)
		}
	}
}

// TestVerifyTOTPWindow confirms a code is accepted within ±1 period and rejected
// outside it.
func TestVerifyTOTPWindow(t *testing.T) {
	base := time.Unix(59, 0) // code "287082" (counter 1)
	if !verifyTOTP(rfcSecret, "287082", base) {
		t.Error("code should verify at its own timestamp")
	}
	if !verifyTOTP(rfcSecret, "287082", base.Add(25*time.Second)) {
		t.Error("code should verify +25s (same period)")
	}
	if !verifyTOTP(rfcSecret, "287082", base.Add(-30*time.Second)) {
		t.Error("code should verify one period early (skew tolerance)")
	}
	if verifyTOTP(rfcSecret, "287082", base.Add(90*time.Second)) {
		t.Error("code should NOT verify two periods later")
	}
	if verifyTOTP(rfcSecret, "000000", base) {
		t.Error("a wrong code must not verify")
	}
	if verifyTOTP(rfcSecret, "28708", base) {
		t.Error("a non-6-digit code must not verify")
	}
}

func TestGenerateTOTPSecretIsUsable(t *testing.T) {
	s, err := generateTOTPSecret()
	if err != nil {
		t.Fatalf("generateTOTPSecret: %v", err)
	}
	if len(s) < 16 {
		t.Errorf("secret too short: %q", s)
	}
	// A freshly generated secret must round-trip through code generation.
	if _, err := totpAt(s, time.Unix(0, 0)); err != nil {
		t.Errorf("generated secret not decodable: %v", err)
	}
}

func TestHashBackupCodeNormalization(t *testing.T) {
	// Dashes, case and surrounding whitespace must not change the hash.
	h1 := hashBackupCode("ab12c-d34ef")
	h2 := hashBackupCode("  AB12C-D34EF  ")
	h3 := hashBackupCode("ab12cd34ef")
	if h1 != h2 || h1 != h3 {
		t.Errorf("normalization mismatch: %q / %q / %q", h1, h2, h3)
	}
	if hashBackupCode("ab12cd34ef") == hashBackupCode("ffffffffff") {
		t.Error("different codes must hash differently")
	}
}

func TestGenerateBackupCodesFormat(t *testing.T) {
	codes, err := generateBackupCodes(10)
	if err != nil {
		t.Fatalf("generateBackupCodes: %v", err)
	}
	if len(codes) != 10 {
		t.Fatalf("want 10 codes, got %d", len(codes))
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if len(c) != 11 || c[5] != '-' {
			t.Errorf("unexpected code format: %q", c)
		}
		if seen[c] {
			t.Errorf("duplicate code generated: %q", c)
		}
		seen[c] = true
	}
}

func TestOtpauthURL(t *testing.T) {
	u := otpauthURL("Dockyard", "alice", rfcSecret)
	for _, want := range []string{"otpauth://totp/", "secret=" + rfcSecret, "issuer=Dockyard", "period=30", "digits=6"} {
		if !strings.Contains(u, want) {
			t.Errorf("otpauth URL missing %q: %s", want, u)
		}
	}
}

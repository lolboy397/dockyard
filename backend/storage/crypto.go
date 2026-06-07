package storage

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// encPrefix marks values encrypted by encryptSecret so decryptSecret can tell
// them apart from legacy plaintext stored before encryption was introduced.
const encPrefix = "enc:"

var encKey []byte

// secretKeyExternal is true when the at-rest key came from $DOCKYARD_SECRET_KEY
// (managed out-of-band) rather than the generated /data/secret.key file. The
// application-backup engine uses this to decide whether secret.key must be
// included in the archive.
var secretKeyExternal bool

// SecretKeyExternal reports whether the encryption key is supplied via the
// environment (so it is NOT stored in the data volume and need not be archived).
func SecretKeyExternal() bool { return secretKeyExternal }

// initSecretKey loads the at-rest encryption key from $DOCKYARD_SECRET_KEY
// (base64, 32 bytes) or a key persisted next to the database, generating and
// persisting one on first run. If no key can be established, secrets are stored
// as-is (encryption is a no-op) rather than failing startup.
func initSecretKey(dbPath string) {
	if v := strings.TrimSpace(os.Getenv("DOCKYARD_SECRET_KEY")); v != "" {
		if k, err := base64.StdEncoding.DecodeString(v); err == nil && len(k) == 32 {
			encKey = k
			secretKeyExternal = true
			log.Println("[secrets] at-rest encryption key loaded from $DOCKYARD_SECRET_KEY")
			return
		}
		log.Println("[secrets] WARNING: $DOCKYARD_SECRET_KEY is set but is not a valid base64-encoded 32-byte key; ignoring it")
	}
	dir := filepath.Dir(dbPath)
	if dir == "" || dbPath == ":memory:" {
		dir = "."
	}
	keyPath := filepath.Join(dir, "secret.key")
	if data, err := os.ReadFile(keyPath); err == nil && len(data) == 32 {
		encKey = data
		log.Printf("[secrets] at-rest encryption key loaded from %s", keyPath)
		return
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		log.Printf("[secrets] WARNING: could not generate an encryption key (%v); git tokens and stack secrets will be stored UNENCRYPTED", err)
		return
	}
	if err := os.WriteFile(keyPath, k, 0o600); err != nil {
		// The key is held in memory for this process but won't survive a restart,
		// so anything encrypted now would later become undecryptable.
		log.Printf("[secrets] WARNING: generated an encryption key but could not persist it to %s (%v) — set $DOCKYARD_SECRET_KEY to manage the key out-of-band", keyPath, err)
		encKey = k
		return
	}
	encKey = k
	log.Printf("[secrets] generated a NEW at-rest encryption key at %s", keyPath)
	log.Printf("[secrets] IMPORTANT: this key encrypts your git tokens and stack secrets. Back it up together with the database (it lives in the same volume), or set $DOCKYARD_SECRET_KEY to manage it out-of-band. Losing it makes those secrets unrecoverable — see BACKUP.md.")
}

// encryptSecret returns an AES-GCM ciphertext (prefixed + base64) for a secret,
// or the input unchanged when empty or no key is configured.
func encryptSecret(plaintext string) string {
	if plaintext == "" || len(encKey) != 32 {
		return plaintext
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return plaintext
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return plaintext
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return plaintext
	}
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return encPrefix + base64.StdEncoding.EncodeToString(ct)
}

// decryptSecret reverses encryptSecret. Values without the prefix are returned
// unchanged (legacy plaintext); undecryptable values return "".
func decryptSecret(s string) string {
	if !strings.HasPrefix(s, encPrefix) || len(encKey) != 32 {
		return s
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, encPrefix))
	if err != nil {
		return ""
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return ""
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(raw) < gcm.NonceSize() {
		return ""
	}
	nonce, ct := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return ""
	}
	return string(pt)
}

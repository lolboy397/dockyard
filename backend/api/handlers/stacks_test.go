package handlers

import "testing"

func TestComposePrivilegedDirective(t *testing.T) {
	// Benign compose content must NOT be flagged.
	safe := []string{
		`services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html
      - appdata:/var/lib/app`,
		`services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: secret
    networks:
      - back`,
	}
	for i, c := range safe {
		if d := composePrivilegedDirective(c); d != "" {
			t.Errorf("safe[%d]: flagged as %q, want none", i, d)
		}
	}

	// Each of these must be flagged.
	dangerous := []string{
		"services:\n  x:\n    image: a\n    privileged: true",
		"services:\n  x:\n    image: a\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock",
		"services:\n  x:\n    image: a\n    volumes:\n      - /run/docker.sock:/run/docker.sock",
		"services:\n  x:\n    image: a\n    cap_add:\n      - SYS_ADMIN",
		"services:\n  x:\n    image: a\n    pid: host",
		"services:\n  x:\n    image: a\n    ipc: host",
		"services:\n  x:\n    image: a\n    userns_mode: host",
		"services:\n  x:\n    image: a\n    security_opt:\n      - seccomp:unconfined",
		"services:\n  x:\n    image: a\n    volumes:\n      - /:/host",
	}
	for i, c := range dangerous {
		if d := composePrivilegedDirective(c); d == "" {
			t.Errorf("dangerous[%d]: not flagged, want a directive name\n%s", i, c)
		}
	}
}

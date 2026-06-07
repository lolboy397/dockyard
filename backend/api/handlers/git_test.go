package handlers

import (
	"net/http/httptest"
	"testing"
)

func TestValidateGitURL(t *testing.T) {
	valid := []string{
		"https://github.com/acme/app.git",
		"http://gitserver.local/x.git",
		"ssh://git@host/acme/app.git",
		"git@github.com:acme/app.git", // scp-style
		"git://host/repo.git",
	}
	for _, u := range valid {
		if err := validateGitURL(u); err != nil {
			t.Errorf("validateGitURL(%q) = %v, want nil", u, err)
		}
	}

	invalid := []string{
		"",                       // empty
		"-oProxyCommand=sh",      // leading dash (argument injection)
		`ext::sh -c "id"`,        // remote-helper RCE
		"fd::17/foo",             // remote-helper
		"file:///etc/passwd",     // local file transport
		"unknown://host/x",       // disallowed scheme
	}
	for _, u := range invalid {
		if err := validateGitURL(u); err == nil {
			t.Errorf("validateGitURL(%q) = nil, want error", u)
		}
	}
}

func TestValidateGitRef(t *testing.T) {
	if err := validateGitRef("main"); err != nil {
		t.Errorf("validateGitRef(main) = %v, want nil", err)
	}
	if err := validateGitRef("feature/x"); err != nil {
		t.Errorf("validateGitRef(feature/x) = %v, want nil", err)
	}
	if err := validateGitRef("--upload-pack=sh"); err == nil {
		t.Error("validateGitRef(--upload-pack=sh) = nil, want error")
	}
}

func TestRedactCreds(t *testing.T) {
	cases := map[string]string{
		"fatal: could not read from https://alice:ghp_secret@github.com/x.git": "fatal: could not read from https://***@github.com/x.git",
		"remote: https://user:tok@gitlab.com/y rejected":                       "remote: https://***@gitlab.com/y rejected",
		"no credentials https://github.com/public/repo.git here":               "no credentials https://github.com/public/repo.git here",
	}
	for in, want := range cases {
		if got := redactCreds(in); got != want {
			t.Errorf("redactCreds(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

func TestIsReceivePack(t *testing.T) {
	push1 := httptest.NewRequest("GET", "/git/x.git/info/refs?service=git-receive-pack", nil)
	push2 := httptest.NewRequest("POST", "/git/x.git/git-receive-pack", nil)
	fetch1 := httptest.NewRequest("GET", "/git/x.git/info/refs?service=git-upload-pack", nil)
	fetch2 := httptest.NewRequest("POST", "/git/x.git/git-upload-pack", nil)

	if !isReceivePack(push1) || !isReceivePack(push2) {
		t.Error("receive-pack requests not detected as push")
	}
	if isReceivePack(fetch1) || isReceivePack(fetch2) {
		t.Error("upload-pack (fetch) requests wrongly detected as push")
	}
}

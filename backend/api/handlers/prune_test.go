package handlers

import "testing"

func TestImageIsDangling(t *testing.T) {
	cases := []struct {
		name string
		tags []string
		want bool
	}{
		{"no tags", nil, true},
		{"empty slice", []string{}, true},
		{"explicit none", []string{"<none>:<none>"}, true},
		{"real tag", []string{"nginx:latest"}, false},
		{"mixed none+real", []string{"<none>:<none>", "nginx:1.25"}, false},
	}
	for _, c := range cases {
		if got := imageIsDangling(c.tags); got != c.want {
			t.Errorf("%s: imageIsDangling(%v) = %v, want %v", c.name, c.tags, got, c.want)
		}
	}
}

func TestImageRepoTag(t *testing.T) {
	if got := imageRepoTag([]string{"nginx:latest"}, "sha256:abc"); got != "nginx:latest" {
		t.Errorf("tagged: got %q", got)
	}
	if got := imageRepoTag([]string{"<none>:<none>"}, "sha256:abcdef0123456789"); got != "<none>:abcdef012345" {
		t.Errorf("dangling: got %q", got)
	}
	if got := imageRepoTag(nil, "sha256:abcdef0123456789"); got != "<none>:abcdef012345" {
		t.Errorf("untagged: got %q", got)
	}
}

func TestShortID(t *testing.T) {
	if got := shortID("sha256:abcdef0123456789aa"); got != "abcdef012345" {
		t.Errorf("sha-prefixed: got %q", got)
	}
	if got := shortID("short"); got != "short" {
		t.Errorf("short: got %q", got)
	}
}

func TestIsAnonymousVolume(t *testing.T) {
	anon := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" // 64 hex
	if !isAnonymousVolume(anon) {
		t.Errorf("expected %q to be anonymous", anon)
	}
	if isAnonymousVolume("my-named-volume") {
		t.Error("named volume misclassified as anonymous")
	}
	if isAnonymousVolume(anon[:63]) {
		t.Error("63-char string misclassified as anonymous")
	}
	if isAnonymousVolume("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeZ") {
		t.Error("non-hex 64-char string misclassified as anonymous")
	}
}

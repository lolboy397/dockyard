package handlers

import "testing"

func TestParseChangelog(t *testing.T) {
	md := `<!-- a comment, ignored -->
## 0.0.3 — 2026-06-21

### Added
- First feature
- Second feature

### Fixed
- A bug

## 0.0.1 - 2026-06-08
- Bare item with no section
`
	got := parseChangelog(md)
	if len(got) != 2 {
		t.Fatalf("entries = %d, want 2", len(got))
	}

	if got[0].Version != "0.0.3" || got[0].Date != "2026-06-21" {
		t.Errorf("entry[0] = %q/%q, want 0.0.3/2026-06-21", got[0].Version, got[0].Date)
	}
	if len(got[0].Sections) != 2 {
		t.Fatalf("entry[0] sections = %d, want 2", len(got[0].Sections))
	}
	if got[0].Sections[0].Title != "Added" || len(got[0].Sections[0].Items) != 2 {
		t.Errorf("Added section = %+v, want title Added with 2 items", got[0].Sections[0])
	}
	if got[0].Sections[1].Title != "Fixed" || got[0].Sections[1].Items[0] != "A bug" {
		t.Errorf("Fixed section = %+v", got[0].Sections[1])
	}

	// Hyphen separator + a bullet with no preceding section header.
	if got[1].Version != "0.0.1" || got[1].Date != "2026-06-08" {
		t.Errorf("entry[1] = %q/%q, want 0.0.1/2026-06-08", got[1].Version, got[1].Date)
	}
	if len(got[1].Sections) != 1 || got[1].Sections[0].Title != "" || got[1].Sections[0].Items[0] != "Bare item with no section" {
		t.Errorf("entry[1] sections = %+v, want one untitled section with the bare item", got[1].Sections)
	}
}

// The shipped changelog must parse and contain the running version, so the
// Updates page can flag the current release.
func TestEmbeddedChangelogIncludesCurrentVersion(t *testing.T) {
	entries := parseChangelog(changelogMarkdown)
	if len(entries) == 0 {
		t.Fatal("embedded changelog parsed to zero entries")
	}
	found := false
	for _, e := range entries {
		if e.Version == appVersion {
			found = true
		}
		if e.Version == "" {
			t.Errorf("entry has empty version: %+v", e)
		}
	}
	if !found {
		t.Errorf("embedded changelog has no entry for the running version %q", appVersion)
	}
}

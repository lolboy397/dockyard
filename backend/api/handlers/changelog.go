package handlers

import (
	_ "embed"
	"net/http"
	"strings"
)

//go:embed changelog.md
var changelogMarkdown string

// ChangelogSection groups changelog items under a category (Added / Fixed / …).
type ChangelogSection struct {
	Title string   `json:"title"`
	Items []string `json:"items"`
}

// ChangelogEntry is one released version's notes.
type ChangelogEntry struct {
	Version  string             `json:"version"`
	Date     string             `json:"date"`
	Current  bool               `json:"current"` // matches the running build's version
	Sections []ChangelogSection `json:"sections"`
}

// Changelog returns the parsed, embedded release notes (newest first), flagging
// the entry that matches the running version. Open to any authenticated user —
// it's just release notes.
func (h *UpdateHandlers) Changelog(w http.ResponseWriter, r *http.Request) {
	entries := parseChangelog(changelogMarkdown)
	cur := strings.TrimPrefix(strings.TrimSpace(appVersion), "v")
	for i := range entries {
		if entries[i].Version == cur {
			entries[i].Current = true
		}
	}
	writeJSON(w, entries)
}

// parseChangelog parses the lightweight changelog format:
//
//	## <version> — <date>     → a new entry
//	### <category>            → a section within the current entry
//	- <text>  (or * <text>)   → an item within the current section
//
// Anything else (blank lines, HTML comments, prose) is ignored. It indexes into
// the slices directly rather than holding pointers, since appending can reallocate
// the backing array.
func parseChangelog(md string) []ChangelogEntry {
	var entries []ChangelogEntry
	inComment := false
	for _, raw := range strings.Split(md, "\n") {
		line := strings.TrimSpace(raw)

		// Skip HTML comment blocks. Their contents include example "##"/"###"/"-"
		// lines (the format help) that must not be parsed as real entries — and
		// TrimSpace above would otherwise expose those markers.
		if inComment {
			if strings.Contains(line, "-->") {
				inComment = false
			}
			continue
		}
		if strings.HasPrefix(line, "<!--") {
			if !strings.Contains(line, "-->") {
				inComment = true
			}
			continue
		}

		switch {
		case strings.HasPrefix(line, "## "):
			version, date := splitVersionDate(strings.TrimSpace(line[3:]))
			entries = append(entries, ChangelogEntry{Version: version, Date: date})
		case strings.HasPrefix(line, "### "):
			if len(entries) == 0 {
				continue
			}
			ei := len(entries) - 1
			entries[ei].Sections = append(entries[ei].Sections, ChangelogSection{Title: strings.TrimSpace(line[4:])})
		case strings.HasPrefix(line, "- "), strings.HasPrefix(line, "* "):
			if len(entries) == 0 {
				continue
			}
			ei := len(entries) - 1
			if len(entries[ei].Sections) == 0 {
				entries[ei].Sections = append(entries[ei].Sections, ChangelogSection{})
			}
			si := len(entries[ei].Sections) - 1
			entries[ei].Sections[si].Items = append(entries[ei].Sections[si].Items, strings.TrimSpace(line[2:]))
		}
	}
	return entries
}

// splitVersionDate splits "0.0.3 — 2026-06-21" into ("0.0.3", "2026-06-21"),
// tolerating an em dash, en dash or hyphen separator and a leading "v".
func splitVersionDate(s string) (version, date string) {
	for _, sep := range []string{" — ", " – ", " - ", "—", "–"} {
		if i := strings.Index(s, sep); i != -1 {
			return strings.TrimPrefix(strings.TrimSpace(s[:i]), "v"), strings.TrimSpace(s[i+len(sep):])
		}
	}
	return strings.TrimPrefix(strings.TrimSpace(s), "v"), ""
}

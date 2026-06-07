package handlers

import (
	"strings"
	"testing"
)

func TestVBCleanPath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "/v"},
		{"/", "/v"},
		{"   ", "/v"},
		{"foo", "/v/foo"},
		{"/foo/bar", "/v/foo/bar"},
		{"foo/bar/", "/v/foo/bar"},
		{"a/./b", "/v/a/b"},
		{"foo/../bar", "/v/bar"},
		{"  spaced  ", "/v/spaced"},
		// Traversal attempts must never escape the /v mount root.
		{"../../etc/passwd", "/v/etc/passwd"},
		{"../../../../../../etc/shadow", "/v/etc/shadow"},
		{`..\..\windows\system32`, "/v/windows/system32"},
		{"foo/../../bar", "/v/bar"},
	}
	for _, c := range cases {
		got := vbCleanPath(c.in)
		if got != c.want {
			t.Errorf("vbCleanPath(%q) = %q, want %q", c.in, got, c.want)
		}
		if got != "/v" && !strings.HasPrefix(got, "/v/") {
			t.Errorf("vbCleanPath(%q) = %q escaped the mount root", c.in, got)
		}
		if strings.Contains(got, "..") {
			t.Errorf("vbCleanPath(%q) = %q still contains '..'", c.in, got)
		}
	}
}

func TestParseStatLines(t *testing.T) {
	out := []byte("regular file|123|1700000000|./foo.txt\n" +
		"directory|0|1700000100|./bar\n" +
		"symbolic link|10|1700000200|./link\n" +
		"\n" +
		"garbage line without pipes\n")
	entries := parseStatLines(out, false)
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3: %+v", len(entries), entries)
	}
	if entries[0].Name != "foo.txt" || entries[0].Type != "file" || entries[0].Size != 123 || entries[0].Modified != 1700000000 {
		t.Errorf("entry[0] = %+v", entries[0])
	}
	if entries[1].Name != "bar" || entries[1].Type != "dir" {
		t.Errorf("entry[1] = %+v (want dir 'bar')", entries[1])
	}
	if entries[2].Type != "file" { // symlinks are reported as files
		t.Errorf("entry[2] = %+v (want file)", entries[2])
	}
}

func TestParseStatLinesWithPath(t *testing.T) {
	out := []byte("regular file|5|1700000000|./a/b/c.txt\n" +
		"directory|0|1700000000|./a/b\n")
	entries := parseStatLines(out, true)
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if entries[0].Name != "c.txt" || entries[0].Path != "a/b/c.txt" {
		t.Errorf("entry[0] = %+v (want name c.txt, path a/b/c.txt)", entries[0])
	}
	if entries[1].Name != "b" || entries[1].Path != "a/b" || entries[1].Type != "dir" {
		t.Errorf("entry[1] = %+v", entries[1])
	}
}

func TestParseStatLinesEmpty(t *testing.T) {
	if got := parseStatLines(nil, false); len(got) != 0 {
		t.Errorf("parseStatLines(nil) = %+v, want empty", got)
	}
	if got := parseStatLines([]byte("\n\n"), false); len(got) != 0 {
		t.Errorf("parseStatLines(blank) = %+v, want empty", got)
	}
}

func TestSanitizeFilename(t *testing.T) {
	cases := []struct{ in, want string }{
		{"file.txt", "file.txt"},
		{`a"b`, "ab"},
		{"a\nb\rc", "abc"},
		{`back\slash`, "backslash"},
		{"", "download"},
		{"\x00\x01", "download"},
	}
	for _, c := range cases {
		if got := sanitizeFilename(c.in); got != c.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAtoiTrim(t *testing.T) {
	cases := map[string]int{"  42\n": 42, "0": 0, "": 0, "  ": 0, "13\t": 13, "x": 0}
	for in, want := range cases {
		if got := atoiTrim(in); got != want {
			t.Errorf("atoiTrim(%q) = %d, want %d", in, got, want)
		}
	}
}

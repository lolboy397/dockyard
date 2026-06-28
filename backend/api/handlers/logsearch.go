package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/go-chi/chi/v5"
)

// Bounds for a history search so a huge or noisy container can't exhaust memory
// or block the server: scan at most this many recent lines, return at most this
// many matches, and give up after the timeout.
const (
	logSearchMaxScan    = 20000
	logSearchMaxMatches = 500
	logSearchTimeout    = 12 * time.Second
)

type logSearchMatch struct {
	TS    string `json:"ts"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

type logSearchResult struct {
	Matches []logSearchMatch `json:"matches"`
	Scanned int              `json:"scanned"`
	// Truncated is true when the scan or match cap was hit (or the timeout fired),
	// so the client can say "showing first N — narrow the search" honestly.
	Truncated bool `json:"truncated"`
}

// SearchLogs scans a bounded window of a container's recent history for lines
// matching q (case-insensitive substring, or a regular expression when
// regex=true) and returns the matches with their real timestamp + level. This is
// the server-side complement to the client-side filter, which can only see the
// ~2000 buffered lines. Operator+ only (logs can carry secrets — see canViewLogs).
func (h *ContainerHandlers) SearchLogs(w http.ResponseWriter, r *http.Request) {
	if !canViewLogs(r) {
		writeError(w, http.StatusForbidden, errMsg("operator role required"))
		return
	}
	q := r.URL.Query().Get("q")
	if strings.TrimSpace(q) == "" {
		writeError(w, http.StatusBadRequest, errMsg("q (search text) is required"))
		return
	}

	matchFn, err := compileLogMatcher(q, r.URL.Query().Get("regex") == "true")
	if err != nil {
		writeError(w, http.StatusBadRequest, errMsg("invalid regular expression: "+err.Error()))
		return
	}

	limit := logSearchMaxMatches
	if v, e := strconv.Atoi(r.URL.Query().Get("limit")); e == nil && v > 0 && v < limit {
		limit = v
	}

	ctx, cancel := context.WithTimeout(r.Context(), logSearchTimeout)
	defer cancel()

	rc, err := h.docker.ContainerLogs(ctx, chi.URLParam(r, "id"), container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     false,
		Tail:       strconv.Itoa(logSearchMaxScan),
		Since:      r.URL.Query().Get("since"),
		Until:      r.URL.Query().Get("until"),
		Timestamps: true,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer rc.Close()

	writeJSON(w, searchLogStream(ctx, rc, matchFn, limit))
}

// compileLogMatcher returns a line predicate: a compiled regexp when useRegex, else
// a case-insensitive substring test.
func compileLogMatcher(q string, useRegex bool) (func(string) bool, error) {
	if useRegex {
		re, err := regexp.Compile(q)
		if err != nil {
			return nil, err
		}
		return re.MatchString, nil
	}
	needle := strings.ToLower(q)
	return func(s string) bool { return strings.Contains(strings.ToLower(s), needle) }, nil
}

// jsonRenderSkip / jsonRenderMsgFields mirror the frontend's parseStructured field
// selection so renderStructured produces the same readable text the operator sees.
var jsonRenderSkip = map[string]bool{
	"level": true, "lvl": true, "severity": true, "levelname": true, "loglevel": true,
	"message": true, "msg": true, "log": true,
	"time": true, "ts": true, "timestamp": true, "t": true, "@timestamp": true,
}
var jsonRenderMsgFields = []string{"message", "msg", "log"}

// renderStructured mirrors the frontend's parseStructured: for a JSON-object log
// line it returns the readable text the operator actually sees — the message
// followed by a " key=value" tail of the remaining fields — so a history search
// matches the RENDERED view (e.g. a "code=500" field chip), not just the raw JSON
// ("code":500). Returns "" when the line isn't a JSON object. Field order is
// irrelevant here: the search only substring/regex-matches the result.
func renderStructured(line string) string {
	s := strings.TrimLeft(line, " \t")
	if s == "" || s[0] != '{' {
		return ""
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var obj map[string]any
	if dec.Decode(&obj) != nil {
		return ""
	}
	var b strings.Builder
	for _, f := range jsonRenderMsgFields {
		if v, ok := obj[f].(string); ok {
			b.WriteString(v)
			break
		}
	}
	for k, v := range obj {
		if jsonRenderSkip[strings.ToLower(k)] {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("  ")
		}
		b.WriteString(k)
		b.WriteByte('=')
		if sv, ok := v.(string); ok {
			b.WriteString(sv)
		} else {
			raw, _ := json.Marshal(v)
			b.Write(raw)
		}
	}
	return b.String()
}

// matchLine matches q against the raw line AND, for a JSON line, its rendered form
// — additive, so raw and free-text matches are never lost while rendered-form
// field filters (key=value) now match too.
func matchLine(matchFn func(string) bool, msg string) bool {
	if matchFn(msg) {
		return true
	}
	if r := renderStructured(msg); r != "" {
		return matchFn(r)
	}
	return false
}

// searchLogStream demuxes a Docker (non-TTY) log stream and returns the lines
// matching matchFn — up to limit matches, scanning at most logSearchMaxScan lines.
// Factored out of the handler so it is table-testable against canned multiplexed
// bytes. It reuses splitLogTimestamp + lineLevel so results classify exactly like
// the live stream.
func searchLogStream(ctx context.Context, rc io.Reader, matchFn func(string) bool, limit int) logSearchResult {
	pr, pw := io.Pipe()
	go func() {
		_, copyErr := stdcopy.StdCopy(pw, pw, rc)
		pw.CloseWithError(copyErr)
	}()

	res := logSearchResult{Matches: []logSearchMatch{}}
	reader := bufio.NewReader(pr)
	for res.Scanned < logSearchMaxScan {
		select {
		case <-ctx.Done():
			res.Truncated = true
			pr.CloseWithError(ctx.Err())
			return res
		default:
		}
		line, readErr := reader.ReadString('\n')
		if line != "" {
			res.Scanned++
			ts, msg := splitLogTimestamp(strings.TrimRight(line, "\r\n"))
			if matchLine(matchFn, msg) {
				if len(res.Matches) >= limit {
					res.Truncated = true
					pr.CloseWithError(nil) // stop the copier; more matches exist
					return res
				}
				res.Matches = append(res.Matches, logSearchMatch{TS: ts, Level: lineLevel(msg), Text: msg})
			}
		}
		if readErr != nil {
			pr.CloseWithError(nil)
			return res
		}
	}
	// Hit the scan cap with more history potentially behind it.
	res.Truncated = true
	pr.CloseWithError(nil)
	return res
}

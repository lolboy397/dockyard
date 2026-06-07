package handlers

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/go-chi/chi/v5"
)

// ─────────────────────────────────────────────────────────────────────────────
// Volume file browser
//
// The backend has no direct access to a volume's contents (it talks to Docker
// through a socket proxy and cannot read host paths). To browse a volume we run
// a tiny throw-away helper container that mounts the volume read-only at /v and
// exec short, fixed shell commands (ls/stat/cat/du/find) inside it. One helper
// is kept warm per volume so navigation is snappy, and idle helpers are reaped.
//
// Safety: the requested sub-path is cleaned to an absolute path with no ".."
// segments and always prefixed with the mount root, then passed to the helper
// as an argv element (never interpolated into a shell string), so it can neither
// escape /v nor inject a command. The mount is read-only.
// ─────────────────────────────────────────────────────────────────────────────

const (
	vbMountTarget  = "/v"
	vbLabel        = "docker-manager.volume-browser"
	vbIdleTTL      = 5 * time.Minute
	vbPreviewLimit = 256 * 1024 // max bytes returned for an inline text preview
	vbExecTimeout  = 30 * time.Second
	vbSearchLimit  = 500 // max search hits returned
)

type vbHelper struct {
	id       string
	lastUsed time.Time
}

type volumeBrowser struct {
	docker     *client.Client
	image      string
	mu         sync.Mutex
	helpers    map[string]*vbHelper
	volLocks   map[string]*sync.Mutex // serialises helper creation per volume
	imageReady bool
}

func newVolumeBrowser(cli *client.Client) *volumeBrowser {
	img := strings.TrimSpace(os.Getenv("VOLUME_BROWSER_IMAGE"))
	if img == "" {
		img = "busybox:latest"
	}
	b := &volumeBrowser{docker: cli, image: img, helpers: map[string]*vbHelper{}, volLocks: map[string]*sync.Mutex{}}
	go b.reapLoop()
	go b.sweepStale(context.Background()) // clean helpers left over from a prior run
	return b
}

// lockVol returns an unlock func after acquiring the per-volume creation lock.
// This serialises helper creation for a single volume so concurrent requests
// (e.g. the explorer firing list + usage at once) share one helper instead of
// each spawning — and leaking — its own.
func (b *volumeBrowser) lockVol(vol string) func() {
	b.mu.Lock()
	lk, ok := b.volLocks[vol]
	if !ok {
		lk = &sync.Mutex{}
		b.volLocks[vol] = lk
	}
	b.mu.Unlock()
	lk.Lock()
	return lk.Unlock
}

// vbEntry is one directory entry returned to the client.
type vbEntry struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // "dir" | "file"
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"` // unix seconds
	Path     string `json:"path,omitempty"`
}

// vbCleanPath maps an untrusted sub-path to a safe absolute path under /v.
// The result can never escape the mount because the cleaned path is absolute
// and contains no ".." segments before it is joined onto the mount root.
func vbCleanPath(sub string) string {
	s := strings.ReplaceAll(strings.TrimSpace(sub), "\\", "/")
	p := path.Clean("/" + s) // absolute, no "." or ".." segments
	if p == "/" {
		return vbMountTarget
	}
	return vbMountTarget + p
}

// ---- helper lifecycle -------------------------------------------------------

func (b *volumeBrowser) reapLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		b.reapIdle()
	}
}

func (b *volumeBrowser) reapIdle() {
	now := time.Now()
	var dead []string
	b.mu.Lock()
	for vol, h := range b.helpers {
		if now.Sub(h.lastUsed) > vbIdleTTL {
			dead = append(dead, h.id)
			delete(b.helpers, vol)
		}
	}
	b.mu.Unlock()
	for _, id := range dead {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		b.docker.ContainerRemove(ctx, id, container.RemoveOptions{Force: true}) //nolint:errcheck
		cancel()
	}
}

// sweepStale removes any helper containers left behind by a previous process.
func (b *volumeBrowser) sweepStale(ctx context.Context) {
	f := filters.NewArgs()
	f.Add("label", vbLabel+"=1")
	list, err := b.docker.ContainerList(ctx, container.ListOptions{All: true, Filters: f})
	if err != nil {
		return
	}
	for _, c := range list {
		b.docker.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true}) //nolint:errcheck
	}
}

func (b *volumeBrowser) ensureImage(ctx context.Context) error {
	b.mu.Lock()
	ready := b.imageReady
	b.mu.Unlock()
	if ready {
		return nil
	}
	if _, _, err := b.docker.ImageInspectWithRaw(ctx, b.image); err == nil {
		b.mu.Lock()
		b.imageReady = true
		b.mu.Unlock()
		return nil
	}
	rc, err := b.docker.ImagePull(ctx, b.image, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("pull %s: %w", b.image, err)
	}
	io.Copy(io.Discard, rc) //nolint:errcheck
	rc.Close()
	b.mu.Lock()
	b.imageReady = true
	b.mu.Unlock()
	return nil
}

func (b *volumeBrowser) running(ctx context.Context, id string) bool {
	info, err := b.docker.ContainerInspect(ctx, id)
	return err == nil && info.State != nil && info.State.Running
}

// liveHelper returns a tracked, still-running helper for vol (refreshing its
// last-used time). A tracked-but-dead helper is evicted and reported as absent.
func (b *volumeBrowser) liveHelper(ctx context.Context, vol string) (string, bool) {
	b.mu.Lock()
	h, ok := b.helpers[vol]
	if !ok {
		b.mu.Unlock()
		return "", false
	}
	id := h.id
	h.lastUsed = time.Now()
	b.mu.Unlock()

	if b.running(ctx, id) {
		return id, true
	}
	// Stale (container died/removed) — drop and clean up.
	b.mu.Lock()
	if cur, ok := b.helpers[vol]; ok && cur.id == id {
		delete(b.helpers, vol)
	}
	b.mu.Unlock()
	b.docker.ContainerRemove(context.Background(), id, container.RemoveOptions{Force: true}) //nolint:errcheck
	return "", false
}

// helperID returns a warm helper container for vol, creating one if necessary.
func (b *volumeBrowser) helperID(ctx context.Context, vol string) (string, error) {
	// Fast path: an existing, still-running helper.
	if id, ok := b.liveHelper(ctx, vol); ok {
		return id, nil
	}

	// Slow path: serialise creation per volume, then re-check (another goroutine
	// may have created the helper while we waited on the lock).
	unlock := b.lockVol(vol)
	defer unlock()
	if id, ok := b.liveHelper(ctx, vol); ok {
		return id, nil
	}

	if err := b.ensureImage(ctx); err != nil {
		return "", err
	}

	created, err := b.docker.ContainerCreate(ctx,
		&container.Config{
			Image:  b.image,
			Cmd:    []string{"tail", "-f", "/dev/null"},
			Labels: map[string]string{vbLabel: "1", "docker-manager.volume": vol},
		},
		&container.HostConfig{
			Mounts:      []mount.Mount{{Type: mount.TypeVolume, Source: vol, Target: vbMountTarget, ReadOnly: true}},
			NetworkMode: "none",
			AutoRemove:  false,
		}, nil, nil, "")
	if err != nil {
		return "", fmt.Errorf("create helper: %w", err)
	}
	if err := b.docker.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		b.docker.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true}) //nolint:errcheck
		return "", fmt.Errorf("start helper: %w", err)
	}
	b.mu.Lock()
	b.helpers[vol] = &vbHelper{id: created.ID, lastUsed: time.Now()}
	b.mu.Unlock()
	return created.ID, nil
}

// exec runs argv inside vol's helper and returns its stdout, stderr and exit code.
func (b *volumeBrowser) exec(ctx context.Context, vol string, argv []string) (stdout, stderr []byte, exitCode int, err error) {
	id, err := b.helperID(ctx, vol)
	if err != nil {
		return nil, nil, -1, err
	}
	ex, err := b.docker.ContainerExecCreate(ctx, id, container.ExecOptions{
		Cmd:          argv,
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		return nil, nil, -1, err
	}
	att, err := b.docker.ContainerExecAttach(ctx, ex.ID, container.ExecAttachOptions{})
	if err != nil {
		return nil, nil, -1, err
	}
	defer att.Close()

	var outBuf, errBuf bytes.Buffer
	if _, copyErr := stdcopy.StdCopy(&outBuf, &errBuf, att.Reader); copyErr != nil {
		return outBuf.Bytes(), errBuf.Bytes(), -1, copyErr
	}
	code := 0
	if insp, ierr := b.docker.ContainerExecInspect(ctx, ex.ID); ierr == nil {
		code = insp.ExitCode
	}
	return outBuf.Bytes(), errBuf.Bytes(), code, nil
}

// ---- operations -------------------------------------------------------------

// listScript enumerates a directory's entries (including dot files) and prints
// one "type|size|mtime|name" line each. Entries are prefixed with "./" so names
// beginning with "-" are never read as options.
const listScript = `cd "$0" 2>/dev/null || exit 3
for e in * .[!.]* ..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  stat -c '%F|%s|%Y|%n' "./$e"
done`

func (b *volumeBrowser) list(ctx context.Context, vol, sub string) ([]vbEntry, error) {
	dir := vbCleanPath(sub)
	out, _, code, err := b.exec(ctx, vol, []string{"sh", "-c", listScript, dir})
	if err != nil {
		return nil, err
	}
	if code == 3 {
		return nil, errMsg("not a directory")
	}
	return parseStatLines(out, false), nil
}

// searchScript finds entries whose name matches *q* anywhere under the volume
// root and stats each match. q is passed as $1 (an argv element), so it is a
// find pattern only — never shell-evaluated.
var searchScript = `cd /v 2>/dev/null || exit 3
find . -iname "*$1*" 2>/dev/null | head -n ` + strconv.Itoa(vbSearchLimit) + ` | while IFS= read -r p; do
  [ "$p" = "." ] && continue
  stat -c '%F|%s|%Y|%n' "$p"
done`

func (b *volumeBrowser) search(ctx context.Context, vol, q string) ([]vbEntry, error) {
	out, _, code, err := b.exec(ctx, vol, []string{"sh", "-c", searchScript, "vb", q})
	if err != nil {
		return nil, err
	}
	if code == 3 {
		return nil, errMsg("volume root not readable")
	}
	return parseStatLines(out, true), nil
}

// read returns up to limit+1 bytes of a file (the extra byte lets the caller
// detect truncation) plus the command's exit code.
func (b *volumeBrowser) read(ctx context.Context, vol, sub string, limit int64) ([]byte, int, error) {
	file := vbCleanPath(sub)
	out, _, code, err := b.exec(ctx, vol, []string{"head", "-c", strconv.FormatInt(limit+1, 10), file})
	if err != nil {
		return nil, -1, err
	}
	return out, code, nil
}

// usage computes on-disk size, file/dir counts, a top-level storage breakdown
// and the containers currently mounting the volume.
type vbUsage struct {
	SizeBytes int64         `json:"size_bytes"`
	Files     int           `json:"files"`
	Dirs      int           `json:"dirs"`
	Breakdown []vbBreakdown `json:"breakdown"`
	Mounts    []vbMount     `json:"mounts"`
}
type vbBreakdown struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes"`
}
type vbMount struct {
	Container string `json:"container"`
	Path      string `json:"path"`
	Mode      string `json:"mode"`
}

func (b *volumeBrowser) usage(ctx context.Context, vol string) (*vbUsage, error) {
	u := &vbUsage{Breakdown: []vbBreakdown{}, Mounts: b.mounts(ctx, vol)}

	if out, _, _, err := b.exec(ctx, vol, []string{"du", "-sk", vbMountTarget}); err == nil {
		if f := strings.Fields(string(out)); len(f) > 0 {
			if kb, perr := strconv.ParseInt(f[0], 10, 64); perr == nil {
				u.SizeBytes = kb * 1024
			}
		}
	}
	if out, _, _, err := b.exec(ctx, vol, []string{"sh", "-c", "find /v -type f 2>/dev/null | wc -l"}); err == nil {
		u.Files = atoiTrim(string(out))
	}
	if out, _, _, err := b.exec(ctx, vol, []string{"sh", "-c", "find /v -type d 2>/dev/null | wc -l"}); err == nil {
		if d := atoiTrim(string(out)); d > 0 {
			u.Dirs = d - 1 // exclude the /v root itself
		}
	}
	if out, _, _, err := b.exec(ctx, vol, []string{"sh", "-c", "du -sk /v/* 2>/dev/null | sort -rn | head -n 8"}); err == nil {
		for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) != 2 {
				parts = strings.Fields(line)
			}
			if len(parts) < 2 {
				continue
			}
			kb, perr := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
			if perr != nil {
				continue
			}
			u.Breakdown = append(u.Breakdown, vbBreakdown{Name: path.Base(strings.TrimSpace(parts[1])), SizeBytes: kb * 1024})
		}
	}
	return u, nil
}

// mounts returns the (non-helper) containers currently mounting vol.
func (b *volumeBrowser) mounts(ctx context.Context, vol string) []vbMount {
	out := []vbMount{}
	list, err := b.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return out
	}
	for _, c := range list {
		if c.Labels[vbLabel] == "1" {
			continue // our own browser helper
		}
		for _, m := range c.Mounts {
			if m.Name != vol {
				continue
			}
			name := c.ID[:12]
			if len(c.Names) > 0 {
				name = strings.TrimPrefix(c.Names[0], "/")
			}
			mode := "ro"
			if m.RW {
				mode = "rw"
			}
			out = append(out, vbMount{Container: name, Path: m.Destination, Mode: mode})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Container < out[j].Container })
	return out
}

// download streams a single file (raw) or a directory (as a tar archive) to w.
func (b *volumeBrowser) download(ctx context.Context, w http.ResponseWriter, vol, sub string) {
	id, err := b.helperID(ctx, vol)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	src := vbCleanPath(sub)
	rc, stat, err := b.docker.CopyFromContainer(ctx, id, src)
	if err != nil {
		writeError(w, http.StatusNotFound, errMsg("path not found"))
		return
	}
	defer rc.Close()

	base := path.Base(src)
	if base == "" || base == "/" || base == "." {
		base = vol
	}

	if stat.Mode.IsDir() {
		// CopyFromContainer already returns a tar of the directory subtree.
		w.Header().Set("Content-Type", "application/x-tar")
		w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(base)+`.tar"`)
		io.Copy(w, rc) //nolint:errcheck
		return
	}

	// Single file: unwrap the one-entry tar and stream its contents.
	tr := tar.NewReader(rc)
	hdr, err := tr.Next()
	if err != nil {
		writeError(w, http.StatusInternalServerError, errMsg("could not read file"))
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(base)+`"`)
	if hdr.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(hdr.Size, 10))
	}
	io.Copy(w, tr) //nolint:errcheck
}

// ---- parsing helpers --------------------------------------------------------

// parseStatLines turns "type|size|mtime|name" lines into entries. When withPath
// is true the name is treated as a path relative to the volume root and both the
// base name and the relative path are populated.
func parseStatLines(out []byte, withPath bool) []vbEntry {
	entries := []vbEntry{}
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 4)
		if len(parts) < 4 {
			continue
		}
		size, _ := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		mtime, _ := strconv.ParseInt(strings.TrimSpace(parts[2]), 10, 64)
		typ := "file"
		if strings.Contains(parts[0], "directory") {
			typ = "dir"
		}
		name := strings.TrimPrefix(parts[3], "./")
		e := vbEntry{Type: typ, Size: size, Modified: mtime}
		if withPath {
			e.Path = name
			e.Name = path.Base(name)
		} else {
			e.Name = name
		}
		entries = append(entries, e)
	}
	return entries
}

func atoiTrim(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

// sanitizeFilename strips characters that could break a Content-Disposition header.
func sanitizeFilename(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r == '\n' || r == '\r' || r < 0x20 {
			return -1
		}
		return r
	}, s)
	if s == "" {
		return "download"
	}
	return s
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handlers
// ─────────────────────────────────────────────────────────────────────────────

// Files lists the entries of a directory inside the volume (path defaults to root).
func (h *VolumeHandlers) Files(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sub := r.URL.Query().Get("path")
	ctx, cancel := context.WithTimeout(r.Context(), vbExecTimeout)
	defer cancel()
	entries, err := h.browser.list(ctx, name, sub)
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, map[string]any{"path": sub, "entries": entries})
}

// File returns an inline preview of a text file (capped, with a binary flag).
func (h *VolumeHandlers) File(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sub := r.URL.Query().Get("path")
	if strings.TrimSpace(sub) == "" {
		writeError(w, http.StatusBadRequest, errMsg("path is required"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), vbExecTimeout)
	defer cancel()
	data, code, err := h.browser.read(ctx, name, sub, vbPreviewLimit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if code != 0 {
		writeError(w, http.StatusNotFound, errMsg("file not found or not readable"))
		return
	}
	truncated := int64(len(data)) > vbPreviewLimit
	if truncated {
		data = data[:vbPreviewLimit]
	}
	binary := !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0
	resp := map[string]any{"binary": binary, "truncated": truncated, "size": len(data)}
	if binary {
		resp["content"] = ""
	} else {
		resp["content"] = string(data)
	}
	writeJSON(w, resp)
}

// Download streams a file (raw) or directory (tar) from the volume to the client.
func (h *VolumeHandlers) Download(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sub := r.URL.Query().Get("path")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	h.browser.download(ctx, w, name, sub)
}

// Search finds entries by name anywhere under the volume root.
func (h *VolumeHandlers) Search(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, map[string]any{"entries": []vbEntry{}})
		return
	}
	if len(q) > 128 {
		q = q[:128]
	}
	ctx, cancel := context.WithTimeout(r.Context(), vbExecTimeout)
	defer cancel()
	entries, err := h.browser.search(ctx, name, q)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"entries": entries})
}

// Usage returns size/count statistics, a storage breakdown and current mounts.
func (h *VolumeHandlers) Usage(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	u, err := h.browser.usage(ctx, name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, u)
}

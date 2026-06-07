# Deferred work — non-functional UI removed / to revisit

This file tracks UI that was **mockup-only** (cosmetic, no real backend) and was
removed or disabled to keep the app honest, plus features worth building later.
Add to it whenever you cut a placeholder instead of shipping the real thing.

## Volume Explorer (`frontend/src/app/components/volumes/volume-explorer.*`)

The explorer is now **fully functional** against real volume contents via the
backend volume file-browser API (`GET /api/v1/volumes/{name}/files|file|search|usage|download`).
A throw-away helper container mounts the volume **read-only** and the backend
exec's `ls`/`stat`/`cat`/`du`/`find` inside it; one helper is kept warm per
volume and idle helpers are reaped after 5 min. (Image: `busybox:latest`,
overridable via `VOLUME_BROWSER_IMAGE`.)

Working today: directory tree (lazy per folder), breadcrumb listing, name
search, text preview (capped at 256 KB, with truncation notice), inline image
preview, per-file / per-folder / whole-volume **download** (tar for dirs),
copy-path, and a real Overview tab (size, file/dir counts, top-level storage
breakdown, and the containers currently mounting the volume).

**Snapshot/versioning — DONE** (shipped as **volume backup/restore**, not native
"snapshots" since Docker has no such primitive). Consistency-aware backup, restore
with validate-before-wipe, retention, download/delete — see `BACKUP.md` and the
**Backups** tab in the volume explorer.

**Still removed because they were cosmetic-only (no backend):**

- **Upload** (header button + "Drop files here to upload" drop zone). Writing
  into a volume needs a **read-write** helper mount + a streaming PUT
  (`PutArchive`) endpoint. Deferred deliberately (the browser mount is RO).
- **Rename / Delete** file actions (were in the right-click menu). Also need an
  RW mount + `mv`/`rm` exec and confirmation UX. Deferred for the same reason.

When picking these up: add an RW variant of the helper (or a per-request RW
container), a `PUT /volumes/{name}/file` (upload) and `POST .../rename` /
`DELETE .../file` set of endpoints, and gate all of them behind `auth.canWrite()`.

**Notes / limitations of the current implementation:**

- Overview `du`/`find` runs on demand; on a multi-GB volume the Overview tab can
  take a few seconds (bounded by a 60 s server timeout).
- Symlinks are listed as files (not followed).
- Search matches names only (not file contents), capped at 500 hits.

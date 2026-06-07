# Dockyard — Developer / Session Reference

How to build, run, test, and work on Dockyard. For **status / what's left**, see
`ROADMAP.md` (single source of truth). For ops, see `BACKUP.md` and `OFFLINE.md`.

## What this is
**Dockyard** — a self-hosted Docker manager (Portainer/Coolify class). Go (chi)
backend + Angular 17 standalone frontend + `registry:2`, deployed via
`docker-compose.yml` (nginx serves the SPA and proxies `/api`, `/ws`, `/git`,
`/webhooks`). The backend talks to Docker through a least-privilege **socket
proxy**, never the raw socket. Branch: **`auth`** (PR target: `main`).

## Recent structural notes
- The `auth/` and resource-page components were **refactored into per-component
  folders** (`<name>/<name>.component.{ts,html,scss}`); inline templates/styles
  are now separate files. Committed (`a7967d4`) and build-verified.
- `backend/storage/secret.key` was **removed from the repo** and gitignored
  (`8001762`); the runtime key lives at `/data/secret.key` or `$DOCKYARD_SECRET_KEY`.
  Note: it still exists in git **history** (commit `fbaecfc`) — scrub before any
  public push (see ROADMAP §A).

## How to build / run / test (Windows + Docker Desktop)
```bash
# build + (re)deploy (run individual services to save time)
docker compose up -d --build              # both
docker compose up -d --build backend      # backend only (Go recompiles)
docker compose up -d --build frontend     # frontend only (Angular)

# reset to a FRESH first-run instance (wipes the SQLite volume)
docker compose rm -sf backend && docker volume rm docker-manager_backend-data && docker compose up -d
```
- App: **http://localhost** (first-run setup wizard → admin). Password rule is min-8-chars only.
- **Run Go tests in a linux container via PowerShell** (NOT git-bash — it mangles `-w /src`):
  ```powershell
  docker run --rm -v "C:/Development/docker-manager/backend:/src" -w /src golang:1.26-alpine sh -c "go test ./... 2>&1"
  ```
  Green packages: `handlers` + `storage`.

## Environment gotchas (important)
- **Git-bash path mangling**: `docker run -w /src …` and `docker exec … cat /data/…` get rewritten to `C:/Program Files/Git/…`. Use the **PowerShell tool** for those, or `MSYS_NO_PATHCONV=1`.
- `backend/api/handlers/system.go` uses `syscall.Statfs` → flagged by the Windows language server but **builds fine under `GOOS=linux`** (the Docker build). Ignore those diagnostics.
- `.dockerignore` files keep host `node_modules` out of the frontend image — don't remove.
- Encryption key: `secret.key` is generated next to the DB (`/data`) and **gitignored**. `$DOCKYARD_SECRET_KEY` (base64, 32 bytes) overrides — see `BACKUP.md`.
- Builds emit harmless `NG8107` (redundant `?.`) warnings and LF→CRLF git warnings.

## DB migrations
Sequential chain `migrate`..`migrateV18`, all wired in `storage/db.go`'s `Open()`
(V10 users.active, V11 metric_samples, V12 alert_rules, V13 stack_env,
V14 stack_deploys, V15 stack_webhooks, V16 project_deploy, V17 alert_rules
for/firing/pending columns [in `alerts.go`], V18 watched_images.update_available).
**New migrations must be appended and wired into `Open()`** — never renumber
existing ones. Note some migration bodies live next to their feature (e.g.
`migrateV17` in `alerts.go`), but all are *called* from `db.go`'s `Open()`.

## Verification patterns that worked
- **API**: fresh reset → setup admin → get bearer token → exercise endpoints →
  assert codes/state. RBAC roles: **admin / operator / viewer** (viewers
  read-only; `/api/v1/users` is admin-only).
- **UI (headless, no creds in repo)**: `npm i playwright-core` in a temp dir,
  `chromium.launch({ channel: 'msedge' })`, POST `/api/v1/auth/login`, inject the
  token into `localStorage['dy_token']`, then drive routes and screenshot.
- **Offline**: load the app with all non-`localhost` requests blocked → expect 0
  external requests, fonts load, icons render.

## Design system
Follow existing patterns: `.content-area/.content-head`, `.gtable`, `app-modal`
(+ `[modal-footer]`), `.btn btn-sm btn-{primary,secondary,ghost}`, `.field/.input`,
CSS tokens in `frontend/src/styles.scss` (`:root` + `:root[data-theme="light"]`),
`NotificationService` (toasts) + `ConfirmDialogService` (promise-based danger
dialog). Reference prototypes live in `system_design/`.

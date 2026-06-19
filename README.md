# Dockyard

A self-hosted **Docker management console** — manage containers, images, volumes,
networks, Compose stacks, builds, a private registry, and more from one web UI.
Think Portainer/Coolify-class, designed to run on your own machine or home server.

- **Backend:** Go (chi) talking to Docker through a least-privilege socket proxy
- **Frontend:** Angular single-page app served by nginx
- **Bundled:** a private image `registry`, all behind one `docker compose` stack
- **Runs fully offline** once the images are built (no CDN, no telemetry)

> ⚠️ **Security note up front.** Dockyard manages the Docker daemon, which is
> effectively **root on the host**. By default it binds to `127.0.0.1` (this
> machine only). Only expose it on networks you trust, and **never put it
> directly on the internet** — see [Accessing Dockyard](#accessing-dockyard).

---

## Features

- **Containers** — list/inspect, start/stop/restart/pause, rename, resource &
  restart-policy edits, live logs, live stats, exec into a shell, prune
- **Images** — list/inspect/history, pull, tag, search Docker Hub, bulk remove,
  prune, opt-in **update watcher** (notifies / auto-updates per image)
- **Volumes** — create/inspect/prune, a real **file explorer** (browse, preview,
  search, download), and **backup / restore** with optional **scheduled backups**
- **Networks** — create/inspect/connect/disconnect/prune
- **Compose stacks** — deploy/update/remove, per-stack env & secrets, logs,
  one-click **rollback** (snapshot history), and **CI deploy webhooks**
- **Projects** — upload a project, build & run it, deploy-on-push via a git hook
- **Builds** — build images (inline Dockerfile or from git), build definitions
- **Registry** — a built-in private registry plus external-registry management
- **Git** — host repositories over smart-HTTP with deploy tokens
- **Observability** — dashboard host metrics with history, events/audit log,
  an **alert-rules** engine (in-app + webhook), and a live **topology** map
- **Users & roles** — first-run admin setup, capability/tier-based **RBAC**
  (admin / operator / viewer + custom roles), sessions, and an attributed audit log

---

## Requirements

- **Docker Engine** 24+ and the **Docker Compose v2** plugin (`docker compose`)
- Linux, macOS, or Windows (Docker Desktop). A Linux host is recommended for a
  24/7 home-server deployment.
- ~1 GB free RAM for the stack; more for whatever you run with it.

---

## Quick start

```bash
git clone https://github.com/lolboy397/dockyard.git
cd dockyard

# (optional) configure ports, LAN exposure, and the encryption key
cp .env.example .env        # then edit .env

# build the images and start the stack
docker compose up -d --build
```

Then open **http://localhost** and complete the **first-run setup wizard** — it
creates your admin account and instance settings. There are **no default
credentials**; the account you create in the wizard is the only one until you add
more from the Users page.

> `http://localhost` is a browser *secure context*, so there's no certificate
> warning even though the bundled HTTPS cert is self-signed. `https://localhost`
> also works (you'll get the expected self-signed warning).

To stop or update:

```bash
docker compose down           # stop (data is preserved in named volumes)
docker compose up -d --build  # rebuild & restart after pulling changes
```

---

## Accessing Dockyard

By default the UI is bound to **`127.0.0.1`**, so it is reachable **only from the
machine running it**. This is deliberate: Dockyard controls the Docker daemon and
is therefore root-equivalent on the host.

| You want to… | Do this |
|---|---|
| Use it on the same machine | Open `http://localhost` — works out of the box |
| Reach it from other devices on a **trusted LAN** | Set `BIND_ADDR=0.0.0.0` in `.env`, then `docker compose up -d`. Reach it at `http://<host-ip>`. |
| Expose it beyond your LAN | **Don't expose it directly.** Put a hardened reverse proxy (Caddy/Traefik/nginx) with **real TLS** and access control in front, on a host you trust, and keep the app bound to loopback or an internal interface. |

**Why so cautious?** Anyone who can reach the UI and authenticate can run
containers, exec shells, and mount host paths — i.e. take over the host. Treat
access to Dockyard like SSH access to the box.

---

## Configuration

All configuration is via environment variables, most conveniently through a
`.env` file (`cp .env.example .env`). See [`.env.example`](.env.example) for the
full annotated list. The most important ones:

| Variable | Default | Purpose |
|---|---|---|
| `BIND_ADDR` | `127.0.0.1` | Host interface the UI binds to (`0.0.0.0` for LAN) |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Host ports for the UI |
| `DOCKYARD_SECRET_KEY` | _(generated)_ | base64 32-byte key encrypting secrets at rest — see below |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated allowed origins (safe default: bearer-token auth, no cookies) |
| `BACKUP_KEEP` | `10` | Volume backups kept per volume |
| `BACKUP_SCHEDULE_TICK_SECONDS` | `300` | Scheduler polling resolution |

### The encryption key (read this before you store secrets)

Git tokens and stack secrets are encrypted at rest with AES-256-GCM. If you don't
set `DOCKYARD_SECRET_KEY`, Dockyard generates a key on first run and stores it at
`/data/secret.key` **inside the `backend-data` volume — the same volume as the
data it protects.** If you lose or recreate that volume, those secrets become
permanently unrecoverable.

For anything you care about, generate a key and keep an independent copy:

```bash
openssl rand -base64 32   # put the result in .env as DOCKYARD_SECRET_KEY=...
```

Store that value somewhere safe (a password manager). The backend logs which key
source it used at startup. See [`BACKUP.md`](BACKUP.md) for the full rationale.

---

## Data & backups

All durable state lives in Docker named volumes:

| Volume | Contents |
|---|---|
| `backend-data` | SQLite DB, encryption key, stacks, hosted repos, uploaded projects |
| `backup-data` | in-app volume backups (regenerable) |
| `registry-data` | images pushed to the built-in registry |

**`backend-data` is the one that matters** — back it up. Dockyard can back up and
restore *any* Docker volume from the UI (Volumes → a volume → **Backups**),
including on a **schedule**. For backing up `backend-data` itself and for
disaster-recovery steps, see [`BACKUP.md`](BACKUP.md).

---

## Upgrades

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically on startup. Back up `backend-data` first;
if an upgrade misbehaves, restore the volume and redeploy the previous image.
Details in [`BACKUP.md`](BACKUP.md).

---

## Deploy from pre-built images (CI / GHCR)

Every push to `main` builds the `backend` and `frontend` images in GitHub Actions
and publishes them to the GitHub Container Registry (GHCR), so a server can run
the stack **without building anything locally**:

```bash
ghcr.io/lolboy397/dockyard-backend:latest
ghcr.io/lolboy397/dockyard-frontend:latest
```

There are two ways to consume them on a server:

**A. Standalone (no repo needed) — recommended.** Copy just
[`docker-compose.images.yml`](docker-compose.images.yml) (and optionally
`.env.example` → `.env`) to the server. It runs purely from the published images
— no source or Dockerfiles required:

```bash
docker compose -f docker-compose.images.yml pull
docker compose -f docker-compose.images.yml up -d
```

**B. From a repo checkout.** The main `docker-compose.yml` also references the
images (it keeps `build:` for local dev), so a checked-out server can just:

```bash
git pull                       # fetch the latest compose file
docker compose pull            # pull the freshly built images (no local build)
docker compose up -d           # restart with the new images
```

Because the repository is private the packages are private too, so log in **once**
on the server with a GitHub token that has the `read:packages` scope (or flip each
package to *public* in its GitHub package settings):

```bash
echo <TOKEN> | docker login ghcr.io -u <github-user> --password-stdin
```

Pin a specific build instead of `latest` by setting `DOCKYARD_TAG` in `.env`
(e.g. `DOCKYARD_TAG=0.0.1` for a `v0.0.1` release tag, or `DOCKYARD_TAG=sha-abc1234`
for an exact commit). Tagged releases (`git tag v0.0.2 && git push --tags`) publish
matching `:0.0.2` / `:0.0` image tags. The server must be `linux/amd64` (the
default build target); for an ARM host, see the note in
[`.github/workflows/release.yml`](.github/workflows/release.yml).

---

## Running offline / air-gapped

Once built, the stack makes **no outbound network calls on its own**. You can
build the images on a connected machine, `docker save` them, and load them on an
air-gapped host. Features that need the internet (Docker Hub pull/search, remote
git, external webhooks) fail gracefully when offline. See [`OFFLINE.md`](OFFLINE.md).

---

## Security model

- **Least-privilege Docker access** — the backend never touches the raw socket;
  it talks to a [`docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
  that allows only the API surface Dockyard needs and denies swarm/secrets/etc.
- **Non-root backend** — the backend process runs as an unprivileged user inside
  its container, plus `no-new-privileges` on every service.
- **Authentication & RBAC** — bearer-token sessions, PBKDF2-hashed passwords,
  login lockout after repeated failures, capability/tier-based roles, and an
  attributed audit log of every mutating action.
- **Secrets at rest** — git tokens and stack secrets are AES-256-GCM encrypted.
- **Hardened web tier** — same-origin WebSocket checks, request body-size limits,
  security headers + CSP, loopback binding by default.

It is production-ready for **single-host / localhost** use. Multi-user,
network-exposed deployments need the extra steps in [`ROADMAP.md`](ROADMAP.md)
(real TLS, registry auth, SSO/2FA, API tokens).

---

## Documentation

| Doc | What's in it |
|---|---|
| [`BACKUP.md`](BACKUP.md) | Backups, restore, the encryption key, upgrades |
| [`OFFLINE.md`](OFFLINE.md) | Offline / air-gapped hosting |
| [`ROADMAP.md`](ROADMAP.md) | Status and what's planned |
| [`HANDOFF.md`](HANDOFF.md) | Build / run / test and the design system (contributors) |
| [`DEFERRED.md`](DEFERRED.md) | Intentionally deferred features |

---

## Development

See [`HANDOFF.md`](HANDOFF.md) for building, running, and testing. In short:

```bash
docker compose up -d --build backend    # rebuild just the Go backend
docker compose up -d --build frontend   # rebuild just the Angular frontend

# backend tests (in a Linux container)
docker run --rm -v "$PWD/backend:/src" -w /src golang:1.26-alpine sh -c "go test ./..."
```

---

## License

No license has been declared for this project yet, so default copyright applies
(all rights reserved). A license will be added before any public release — open
an issue if you need clarity on permitted use in the meantime.

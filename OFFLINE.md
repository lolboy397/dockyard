# Offline / air-gapped hosting

Dockyard is designed to run **fully on a local network with no internet access**.
This documents what works offline, the one-time online step to build the images,
and the few features that inherently need outbound network.

## What runs with no internet

The **entire web UI is self-contained** — no CDN, no Google Fonts, no external
calls at page load:

- **Lucide icons** are vendored at `frontend/public/lucide.min.js` and served
  locally as `/lucide.min.js`.
- **Geist / Geist Mono** fonts are self-hosted via `@fontsource` and bundled into
  the build (woff2 served locally).

Verified by loading the app with every non-`localhost` request blocked: **0
external requests**, both fonts load, all icons render.

Core management — containers, images, volumes, networks, compose stacks, the
local `registry:2`, projects/builds, logs, metrics, events, alerts (in-app),
topology, users/RBAC — all operate against the local Docker socket and need no
internet.

## One-time step: build the images (needs internet once)

Building the Docker images pulls base images and dependencies. Do this **once on
a machine with internet**, then the resulting images run anywhere offline:

```bash
docker compose build          # frontend + backend images (npm, go mod, base images)
docker compose pull registry  # registry:2 base image
```

To move to an air-gapped host, export/import the images:

```bash
# on the connected build host
docker save docker-manager-frontend docker-manager-backend registry:2 -o dockyard-images.tar
# copy dockyard-images.tar to the air-gapped host, then:
docker load -i dockyard-images.tar
docker compose up -d          # images already present locally → no pull needed
```

(Once built, the running stack performs **no** outbound network on its own.)

## Features that inherently need outbound network

These reach the internet **only when you explicitly use them**, and they fail
gracefully offline (clear error, bounded by a timeout — they do not hang or crash
the app). Everything else keeps working.

| Feature | Needs network for | Offline behaviour |
|---|---|---|
| Image **search** / **pull** from Docker Hub | reaching `*.docker.io` | fails with an error; pre-loaded local images and the internal `registry:2` still work |
| Image **update watcher** (opt-in per image) | digest check on Docker Hub | only runs for images you add to the watch list; skips + logs on failure (10s timeout) |
| **External registries** (registry page) | probing a remote registry | fails for remote hosts (5s timeout); internal `registry:5000` works |
| **Alert webhooks** to an external URL | POSTing the webhook | webhook won't deliver; in-app alerts still fire |
| **Git** clone / pull / fetch to a **remote** repo | reaching the git remote | fails; local git (commit, log, status, branches) works offline |

None of the above run automatically on a fresh install — the app makes no
external request until you opt into one of these network features.

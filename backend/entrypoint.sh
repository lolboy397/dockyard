#!/bin/sh
# Dockyard backend entrypoint.
#
# The application runs as a non-root user (uid/gid 10001) for defence-in-depth:
# the backend controls the Docker daemon (through the socket proxy) and holds the
# at-rest encryption key, so a compromise of the Go process should not also be
# container-root.
#
# Docker named volumes are created root-owned, and an instance upgraded from an
# older (root-running) image has root-owned files under /data. So on first start
# we take ownership of the data + backup volumes once — guarded by a marker file
# so later restarts are instant — then drop privileges with su-exec.
set -e

APP_UID=10001
APP_GID=10001
export HOME=/home/app

if [ "$(id -u)" = "0" ]; then
    for d in /data /backups; do
        if [ -d "$d" ] && [ ! -e "$d/.dockyard-owner" ]; then
            echo "[entrypoint] taking ownership of $d for uid ${APP_UID} (one-time)..."
            chown -R "${APP_UID}:${APP_GID}" "$d" 2>/dev/null || true
            : > "$d/.dockyard-owner" 2>/dev/null || true
            chown "${APP_UID}:${APP_GID}" "$d/.dockyard-owner" 2>/dev/null || true
        fi
    done
    chown -R "${APP_UID}:${APP_GID}" "$HOME" 2>/dev/null || true
    exec su-exec "${APP_UID}:${APP_GID}" /app/docker-manager "$@"
fi

# Already running as a non-root user (e.g. an explicit `user:` in compose) — run
# the binary directly without attempting to change ownership.
exec /app/docker-manager "$@"

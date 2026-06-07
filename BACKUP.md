# Backup & restore

All of Dockyard's durable state lives in the **`backend-data`** Docker volume,
mounted at `/data` in the backend container:

| Path | What it holds |
|---|---|
| `/data/docker-manager.db` (+ `-wal`, `-shm`) | users, RBAC, sessions, audit/events, metrics, alert rules, registries, git-repo records, stack env, deploy history, webhooks |
| `/data/secret.key` | **AES-256 master key** that encrypts git tokens and stack secrets at rest |
| `/data/stacks/` | per-stack `docker-compose.yml` + `.env` |
| `/data/repos/`, `/data/projects/` | hosted git repos and uploaded projects |

> ⚠️ **The key and the ciphertext live in the same volume.** If you lose
> `secret.key`, every encrypted git token and stack secret becomes permanently
> undecryptable. Back up the whole volume together, and prefer managing the key
> out-of-band (see below).

In-app **volume backups** (below) are stored separately in the **`backup-data`**
volume (`/backups`), so they never bloat or threaten `backend-data`. They are
regenerable, so they're lower priority to back up than `backend-data`.

## Back up

Stop-free snapshot of the entire volume:

```bash
docker run --rm \
  -v docker-manager_backend-data:/data \
  -v "$PWD":/backup \
  alpine tar czf /backup/dockyard-backup.tgz -C /data .
```

This produces `dockyard-backup.tgz` in the current directory. Store it securely
(it contains the encryption key). For a fully consistent SQLite snapshot you can
optionally stop the backend first (`docker compose stop backend`), though WAL
mode makes a hot copy safe in practice.

## Restore

```bash
docker compose stop backend
docker run --rm \
  -v docker-manager_backend-data:/data \
  -v "$PWD":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/dockyard-backup.tgz -C /data"
docker compose start backend
```

## In-app volume backup / restore (UI)

Any Docker volume can be backed up and restored from the UI: open it from
**Volumes → Browse files → Backups** (or right-click a volume → **Back up…**).

- **Create backup** archives the volume to a gzipped tar in the `backup-data`
  volume. Tick **"Stop the container while backing up"** for a crash-consistent
  copy (recommended for databases); leave it off for a live "hot" copy that
  avoids downtime but may be inconsistent. Each backup is tagged **consistent**
  or **hot copy** accordingly.
- **Restore** stops the consuming container(s), validates the archive, **erases**
  the volume's current contents, extracts the backup, then restarts the
  container(s). A corrupt archive is rejected *before* anything is erased, so a
  failed restore is a no-op rather than data loss.
- **Retention**: the newest **10** backups per volume are kept (override with
  `BACKUP_KEEP`); older archives are pruned from disk automatically.
- Backups can be **downloaded** (`.tar.gz`) and **deleted** individually.

The heavy `tar`/extract work runs in throw-away helper containers that mount the
volumes directly — it never streams through the backend. The backup store is the
volume mounted at `/backups`, auto-discovered by name (override with
`$BACKUP_VOLUME`). Backups are operator+ actions and are recorded in the audit log.

### Scheduled (automatic) backups — opt-in

Each volume can opt in to **automatic backups** from the Backups tab → *Automatic
backups*. Pick a frequency (every 6h / 12h / daily / 3-day / weekly), a retention
count, and whether to stop the container for consistency, then enable it. A
background scheduler then backs the volume up on that cadence with **no browser
open** — ideal for an unattended 24/7 host.

- Off by default; nothing runs until you enable a schedule for a volume.
- Scheduled runs are tagged `scheduled` and logged (`backup_success` /
  `backup_failed`) to the events feed.
- A schedule whose volume no longer exists is silently skipped (no failure spam;
  it resumes if a volume of that name reappears).
- The scheduler polls every 300s by default (`BACKUP_SCHEDULE_TICK_SECONDS`); a
  schedule still fires at most once per its configured interval.

## Recommended: manage the key out-of-band

Set `DOCKYARD_SECRET_KEY` (base64-encoded 32 bytes) on the backend so the master
key is supplied from your secret manager instead of an auto-generated file. Then
the volume backup only needs to protect the database and stacks, and the key is
backed up/rotated separately.

```bash
# generate once, store in your secret manager
openssl rand -base64 32
```

Add it to the backend service environment in `docker-compose.yml`:

```yaml
  backend:
    environment:
      DOCKYARD_SECRET_KEY: "<base64-32-bytes>"
```

If `DOCKYARD_SECRET_KEY` is set, it overrides `/data/secret.key`. Keep using the
**same** key across restores, or previously-encrypted secrets will not decrypt.

## Upgrades

1. Back up the volume (above).
2. Pull/rebuild images: `docker compose build` (or `docker compose pull`).
3. `docker compose up -d` — migrations run automatically at startup.
4. If something goes wrong, restore the volume snapshot and redeploy the prior
   image.

# Dockyard — Production-Readiness Roadmap

Goal: take Dockyard from prototype to a **production-ready** Docker control plane.
It is **production-ready today for the localhost / single-host use case**; the
remaining work is mostly about expanding to **multi-user / network-exposed**
deployments.

Status legend: ✅ done (verified in code) · 🚧 in progress · ⬜ planned.
This file is the single source of truth for status. `HANDOFF.md` covers how to
build/run/test and the design system; it points here for status.

App version: **2.1.0**. Branch: **`auth`** (PR target: `main`).

## Production readiness at a glance

| Target | State | Gates |
|---|---|---|
| **Localhost / single user** | ✅ Ready | Commit + build-verify the in-flight branch (see below) |
| **Multi-user (trusted LAN)** | 🚧 Close | Finish empty/loading/error states |
| **Network / internet-exposed** | ⬜ Not yet | Real TLS, registry auth, SSO/2FA, API tokens |

---

## Delivered (verified in code)

- **Phase 0 — Auth enforced** ✅ `RequireAuth` + `Authorize` + `AuditMutations`
  on every `/api/v1` route; `RequireAuth` on every `/ws` route (same-origin
  `CheckOrigin`, `?token=` for sockets); frontend token interceptor + 401→login.
- **Phase 1 — Multi-tenant & security foundation** ✅ RBAC (admin/operator/viewer)
  enforced backend + UI-gated; admin **Users page** (CRUD); **attributed audit
  log**; **login lockout** (5 fails → 15-min lock); hourly **session sweep**;
  env-scoped **CORS** (`CORS_ALLOWED_ORIGINS`); **hosted-git authenticated**
  (HTTP Basic deploy tokens, receive-pack gated); **git/stack secrets encrypted
  at rest** (AES-GCM, key via `$DOCKYARD_SECRET_KEY` or generated file).
- **Phase 2 — Placeholder/dead content removed** ✅ Prototype mode-switch gone;
  **dashboard uses real data** (no `Math.random`); real **notification center**
  (bell) + **user menu** (avatar/logout) + real version string; **image
  bulk-remove**; dropped every dead Filter/Sort/Plan/Diff/Credentials/Layers
  stub + inert env-switcher; **viewer write-gating + read-only indicator** on
  every page; Projects native `confirm()/prompt()` → shared design-system dialog.
- **Phase 3 — Proactive operations** ✅ Persisted host **metrics time-series**
  (`/system/metrics-history`) + dashboard history that survives navigation;
  **notification center**; **alert-rules engine + UI** (host thresholds /
  container-exited → in-app + webhook).
- **Phase 4 — Deploy & ship** ✅ **App Templates**; **resource-limit/restart-policy
  editor**; **env/secrets manager** (encrypted → `.env`); **one-click rollback**
  (compose-snapshot history); **CI deploy webhooks** (`/webhooks/stack/{name}`);
  **deploy-on-push GitOps** (post-receive hook → `/webhooks/project/{id}`).
- **Phase 5 — Polish** ✅ **Light / system theme** (defaults to OS preference);
  **in-browser topology map** (`/topology`, live CPU/mem, pan/zoom, touch);
  **responsive/mobile shell** (all 16 routes audited at 390/768px);
  **fully offline / air-gap ready** (Lucide icons + Geist fonts vendored locally,
  no CDN at runtime — see `OFFLINE.md`).
- **Phase 6 — Roles & member management (full-stack)** ✅ Capability/tier-based
  **RBAC** replacing the flat admin/operator/viewer strings: 6 immutable **system
  roles** (owner/admin/maintainer/developer/viewer) + admin-created
  **custom roles**, each a capability matrix mapped to an authorization tier
  (`User.Tier` resolved at session load; `canWrite`/`isAdmin`/`Authorize`/git/
  websocket all tier-gated; legacy `operator` auto-migrated to `maintainer`;
  tier-aware last-admin protection). New **Members** (`/users`) and **Roles**
  (`/roles`) screens — ported 1:1 from the `User Management.html` mockup — backed
  by a real API: member **status** (active/invited/suspended), **2FA flag**,
  **auth method**, **last-active**; per-member **activity** (from the audit log)
  and **sessions** (UA/IP, current-device); role list + capability matrix +
  member roster + create-custom-role. Go tests for role seeding, tier derivation,
  custom-role CRUD and user updates; migrations verified against a pre-existing DB.
  **Environment-scoped access is intentionally deferred** (see Remaining §B).
- **Cross-cutting** ✅ **Automated Go tests** (auth/RBAC, storage, encryption,
  alerts, env, webhooks, git, websocket) — `go test ./...` green; **WebSocket
  auto-reconnect** (capped exponential backoff); **global `ErrorHandler`**;
  request body-size limits; least-privilege **Docker socket proxy**;
  **interrupted-job reconciliation on startup** — builds (`queued`/`running`) and
  project builds (`building`) left dangling by a restart are flipped to a clean
  `failed` state with an explanatory log line, so no job is stuck "running"
  forever (a killed `docker build` child cannot resume; running *containers* are
  left untouched).
- **Volume file explorer** ✅ Clicking a volume row opens a full **file-manager
  takeover** of the Volumes page (1:1 port of the supplied design): a directory
  **tree**, a path-breadcrumbed **file list** with in-volume **search**, a
  slide-in **file preview** (code with line numbers / image / no-preview states),
  and an **Overview** tab (size/file/dir stats, storage breakdown, driver +
  **real mountpoint** details, mounted-by, snapshots). Frontend-only:
  `volume-explorer.component.*` + `volume-explorer.data.ts` (the design's
  per-volume sample tree, keyed by name with a default tree) +
  `styles/volume-explorer.scss`. Real volume browsing is a follow-up (see §B).
- **Local-friendly serving** ✅ The frontend is served over **both HTTP and HTTPS
  with no forced HTTP→HTTPS redirect**, so a local instance is reached at
  `http://localhost` — a browser **secure context**, so Chrome shows no "Not
  secure" warning and needs no certificate. HSTS is reserved for real-cert
  deployments (see §B "Real TLS"); the self-signed cert still backs `https://`.
  Frontend container **healthcheck fixed** (IPv4 `http://127.0.0.1/` — `localhost`
  resolved to IPv6 `::1`, where nginx isn't bound).

---

## Remaining

### A. Before calling it "production" — even for localhost
- ⬜ **Commit + build-verify the in-flight branch.** The working tree has a large
  uncommitted refactor (the `auth/` components were moved into per-component
  subfolders; `secret.key` removal is staged). Nothing ships until that's
  committed and `docker compose build` + `go test ./...` are confirmed green.
- ⬜ **Scrub `secret.key` from git history.** It is now gitignored and untracked
  (deletion staged), but it still exists in history. The runtime key lives in
  `/data/secret.key`, so practical risk is low — but scrub before any public push.
- ⬜ **Finish empty/loading/error states.** Present on some pages (e.g.
  containers); make them consistent across every resource page, with Retry.

### B. For expansion beyond localhost (multi-user / network-exposed)
- ⬜ **Real TLS / `wss://`.** Today: self-signed cert baked in, frontend bound to
  `127.0.0.1`. Network exposure needs a real cert + domain behind a hardened
  reverse proxy. _(External resource: cert + domain.)_
- ⬜ **Registry authentication.** `registry:2` is unauthenticated, loopback-bound
  by design. Exposing it requires adding auth.
- ⬜ **SSO / OIDC**, **personal / CI API tokens** — none started; needed for a
  real team.
- ⬜ **2FA / TOTP — finish enforcement.** Phase 6 added a per-member **require-2FA
  flag** (stored + shown in Members), but actual **TOTP enrollment, verification,
  and login enforcement** are not built yet.
- ⬜ **Environments (env-scoped access).** Deliberately deferred in Phase 6 —
  there is no environment model yet, so the capability matrix is **global**. When
  environments land, re-add the per-environment access layer the design mockup
  shows: the Members **Access/scope-chips column**, the **Environment-access**
  sections in member & role detail, and the **env editors** in the edit-member /
  create-role modals — plus backend storage for per-env permissions.
- ⬜ **Invite / add-member UI.** Backend `POST /users` exists, but the Members
  screen has no create form (the mockup's "Invite member" was a static button).
  Add a create/invite-member modal, and a real **email-invite → pending-acceptance**
  flow to back the `invited` status.
- ⬜ **Volume explorer — live contents.** The explorer UI is built (1:1 with the
  design) but browses the design's **sample tree**. Wire it to real volume
  contents: backend `GET /volumes/{name}/files?path=` (list) and `…/file?path=`
  (read, capped) via a short-lived helper container mounting the volume read-only
  (busybox `find`/`stat`/`head`), plus real mounted-by (from container inspect)
  and working Download/Upload/Snapshot actions.
- ⬜ **Custom-role edit & delete UI.** Backend `DELETE /roles/{id}` exists
  (system / in-use roles refused); there is no UI to delete, and **no
  edit-custom-role endpoint/modal** yet.
- ⬜ **Notification channel presets** (Slack / Discord / SMTP) — only generic
  webhook + in-app exist today.
- ⬜ **Per-container health & uptime timeline** — needs a small backend table +
  sampler, then a sparkline in container detail.

### C. Descoped — need resources only the user can provide
- ⬜ **AI copilots** (Cmd+K NL search, "Explain this" log troubleshooting) → LLM API key.
- ⬜ **Image CVE scanning** → Trivy/Grype pinned binary bundled in the image
  (the `curl … | sh` install was blocked by security policy).

### Acceptably skipped
- **CanActivate route guard** — the shell withholds the router-outlet until
  `auth.authed()`, so protected components never instantiate unauthenticated. A
  guard would only save a lazy-chunk fetch and risks a post-login redirect loop.
- **Frontend unit specs** — `ng test` needs a headless-browser harness that
  doesn't run in the image build; low verification value until that exists.

# Logs / Insights backlog — implementation plan

Research pass 2026-06-28 (multi-agent + direct code verification). Covers the five
deferred items from the 47-agent Logs+Insights review, one bonus item the research
surfaced (logs-RBAC), and one **production bug** found while grounding the plan.

All file/line references verified against `main` at time of writing.

---

## P0 — fix first: the `new_issue` alert is broken in production

We shipped the `new_issue` alert rule yesterday (`19b6cbf`), but it is **dead on arrival**:

- Frontend offers it — `alerts.component.html:91` `<option value="new_issue">`.
- Backend evaluates it — `evalAlertRule` `case "new_issue":` (`alerts_eval.go:117`).
- Backend **rejects creating it** — `validAlertType` (`alerts.go:22-28`) only allows
  `host_cpu | host_mem | host_disk | container_exited`. `Create`/`Update` (`alerts.go:50`)
  call `validAlertType`, so any `new_issue` (or future `error_rate`) rule 400s.

**Fix:** add `new_issue` (and, when item 5 lands, `error_rate`) to `validAlertType`, and
update the error string at `alerts.go:51`. Back the valid set with a single source of
truth shared with the `evalAlertRule` switch so the dropdown can never outrun the
validator again. **Effort: XS.** Ship immediately, with a regression test asserting every
frontend-offered type passes `validAlertType`.

---

## The items

Effort key: **XS** minutes · **S** hours · **M** half-day · **L** day+.

### 1. Shared WebSocket keepalive (ping/pong + deadlines) — **M** · build-once foundation

**Problem (verified):** one shared `upgrader` (`websocket.go:26`) feeds **8 routed ws
handlers** (`router.go:359-369`). NONE set `SetReadDeadline` / `SetWriteDeadline` /
`SetPongHandler` or send pings. Dead/half-open sockets (NAT cull, sleeping laptop, proxy
idle-timeout) are only noticed when the Docker stream errors or the OS TCP timer fires
(minutes). There is even an unrouted dead `Ping` handler (`websocket.go:562-578`).

The 8 handlers: `StreamLogs` (`:57`), `StreamMultiLogs` (`:222`), `StreamStats` (`:479`),
`StreamEvents` (`:524`, the RealtimeService firehose), `StreamExec` (`:582`),
`StreamAllStats` (`:681`), plus `StreamBuildLogs` (`projects.go:1654`) and
`StreamDeleteProgress` (`projects.go:1751`). All already follow a uniform
one-reader / one-writer shape.

**Change set:**
- NEW `backend/api/handlers/wskeepalive.go`:
  - `type wsConn struct { *websocket.Conn; mu sync.Mutex }` + `newWSConn`.
  - Mutex-guarded `WriteMessage` (sets `SetWriteDeadline(now+writeWait)` first),
    `WriteJSON`, and `ping()` via `WriteControl(PingMessage, …)`.
  - `startKeepalive(ctx, *wsConn)`: initial `SetReadDeadline(now+pongWait)`, a
    `SetPongHandler` that pushes the deadline forward, and a pinger goroutine wrapped in
    `safe.Recover("ws-keepalive")` (`safe/safe.go:11`).
  - Timing as **package vars** (so tests can shrink them): `writeWait=10s`, `pongWait=60s`,
    `pingPeriod=54s` (must stay strictly `< pongWait`).
- Each of the 8 handlers: rename the `Upgrade` result to `raw`, add `conn := newWSConn(raw)`,
  add `startKeepalive(ctx, conn)`. **Struct embedding** means existing
  `conn.ReadMessage` / `conn.Close` resolve unchanged while `conn.WriteMessage` /
  `conn.WriteJSON` are shadowed by the mutex-guarded versions — so the single-writer
  goroutine in `StreamMultiLogs` (`:268`), the copy goroutine in `StreamExec`, and the
  `sendJSON` / `emit` closures auto-route through the mutex with **zero** body edits.
- Delete the dead `Ping` handler.
- **Frontend: no change.** Browsers auto-pong at the protocol layer;
  `websocket.service.ts` (jittered `streamMultiLogs` backoff) and `realtime.service.ts`
  onclose-reconnect already handle the server-initiated close keepalive will trigger on
  dead links.

**The one hazard:** gorilla forbids two concurrent writers. The wrapper mutex must cover
*every* write (data, ping, early error writes). A future caller reaching the raw embedded
field (`conn.Conn.WriteMessage`) reintroduces the race — doc-comment against it and gate
with `go test -race`.

**Tests:** NEW `wskeepalive_test.go` — (1) httptest upgrade + keepalive + echo, client
counts pings, assert ≥1 ping within `pingPeriod`+slack and the conn outlives `pongWait`
(shrink the vars in-test); (2) `-race` test: pinger concurrent with a tight
`WriteMessage` loop; (3) dead-peer: client stops ponging → server ctx cancels within
shrunken `pongWait`; (4) `WriteJSON` table test. Existing role-gate tests pass unchanged
(they 403 before Upgrade).

### 2. Container restart resubscribe (multiplexed logs) — **M** client-driven (L if server reattach)

**Problem (verified):** when a followed container restarts, `ContainerLogs(Follow:true)`
EOFs, `followLogs` (`websocket.go:376-461`) returns and its sub slot is deleted
(`:316-325`). Nothing re-attaches. On a compose recreate the **container id changes**, so a
same-name container stops logging too. The logs page only (re)subscribes on
`loadContainers()` / manual toggle — it does **not** react to start/die events. Result: a
restarted container silently drops out of the live tail (undercutting yesterday's
honest-connection-state work).

**Primary approach — client-driven (covers `docker restart` same-id AND compose recreate
new-id):**
- `logs-page.component.ts`: inject `RealtimeService`; in `ngOnInit` subscribe to
  `realtime.changes(['container'])` (already 250ms-debounced) → `reconcileSources()` that
  re-runs `listContainers(true)` and reuses the add/remove reconciliation already in
  `loadContainers()` (refactored to be event-callable).
- Carry selection across a recreate **by name**: when the new id misses `sourceById` but a
  prior `on` source with the same name existed, inherit `on=true` and auto-`subscribe` the
  new id, reusing the auto-tracked `since` so it resumes instead of dumping full tail.
- Emit a `status` frame ("container restarted — reattached") so the gap is visible (matches
  the dropped-line status pattern at `websocket.go:284`).

**Optional server-side same-id reattach (defer):** in `followLogs`, on EOF with ctx alive
and the container still running, reopen `ContainerLogs` with `Since=last-seen` and continue
(bounded retries + backoff). Needs a small `logSource` interface over
`ContainerLogs`+`ContainerInspect` to be testable (today `h.docker` is a concrete
`*client.Client`) — that seam is why it's **L**. Ship client-driven first.

**Tests:** frontend spec — emit a `container` change returning a recreated container (new
id, same name) → assert `subscribe` for the new id with carried `on`, `unsubscribe` for the
gone id, `connState` untouched, no duplicate-history regression. If server reattach:
`followLogs` unit test against a fake `logSource` (EOF → running → second stream).

### 3. Bounded server-side history grep — **M**

**Problem (verified):** search is client-side only over the 2000-line buffer
(`logs-page.component.ts`, `MAX_LINES=2000`, `filteredLines` computed). No way to search
deeper history.

**Change set:**
- NEW `backend/api/handlers/logsearch.go` — `SearchLogs(w,r)`, **gated with `canViewLogs(r)`**
  (so item 5 upgrades it for free — do NOT inline a tier check). Params: `id`, `q`, optional
  `regex`, `since`, bounded `limit` + scanned-lines cap (e.g. ≤10k scanned, ≤N matches,
  context timeout). Impl: `ContainerLogs(Follow:false, Tail:<bounded>, Timestamps:true,
  Since:since)` → `io.Pipe` + `stdcopy.StdCopy` → `bufio` scan, reusing `splitLogTimestamp`
  (`websocket.go:467`) and `lineLevel` (`:184`). Substring or compiled `regexp` (compile
  error → 400). Return `{matches:[{ts,level,line}], scanned, truncated}`.
- `router.go`: register `GET /api/v1/containers/{id}/logs/search` in the authed group (the
  in-handler `canViewLogs` is the real gate, same pattern as `StreamLogs`).
- `docker.service.ts`: `searchContainerLogs(id, q, opts)`.
- `logs-page.component.ts` + `.html`: a "Search full history" action next to the filter that
  renders matches in a **separate results drawer/signal** — NOT merged into the live `lines`
  virtual list (protects virtual scroll + OnPush). Each result reuses the existing `?since=`
  deep-link pivot to land the live tail at that moment.

**Tests:** NEW `logsearch_test.go` — role-gate (viewer 403, operator/admin pass); factor the
scan+filter into a pure func over `io.Reader` and table-test (canned multiplexed bytes →
matches, regex error → 400, limit caps). Frontend: service shape, results drawer renders,
invalid regex surfaces, live `lines` unaffected.

### 4. `error_rate` alert (reuses `diag_buckets`) — **S/M**

**Problem (verified):** `new_issue` counts new issue *groups*; `error_rate` should fire when
error-level event *volume* in a recent window crosses a threshold, using the exact hourly
counters in `diag_buckets` (migrateV29). No new table/sink/migration.

**Change set:**
- `storage/diag.go`: `func (db *DB) ErrorCountSince(window time.Duration) (int, error)` —
  `SELECT COALESCE(SUM(count),0) FROM diag_buckets WHERE level='error' AND bucket >= ?` using
  the existing hour-cutoff helper pattern from `DiagStatsSummary`. Document hour-bucket
  granularity (exact counts at hour resolution).
- `alerts_eval.go`: `case "error_rate":` → `n,_ := db.ErrorCountSince(errorRateWindow);
  return n >= int(rule.Threshold), …`. Add `errorRateWindow` const (1h); `ForSeconds` still
  applies as the standard "holds for" gate.
- `alerts.go`: add `error_rate` (and the P0 `new_issue` fix) to `validAlertType`.
- `alerts.component.ts/.html`: `condition()` case ("N+ errors per hour"); `onTypeChange`
  default threshold (e.g. 10); `<option value="error_rate">` + count input (mirror the
  `new_issue` numeric input); empty-state copy.

**Tests:** `diag_test.go` — seed bucketed error/warn/info across hours, assert
`ErrorCountSince` sums only `error` within window. Alerts eval test — fires over threshold,
not under. Regression — `validAlertType("new_issue")` and `("error_rate")` true. Frontend —
`condition()` string + create payload.

### 5. logs-RBAC: dedicated `logs.view` capability — **M** *(surfaced by research, not in original 5)*

**Problem (verified):** `canViewLogs == canWrite` (operator+, `auth.go:145-147`). Its own
comment promises moving the policy to a dedicated capability "without touching the six log
handlers." The capability catalogue + per-user resolution already exist (`storage/roles.go`).

**Change set:**
- `storage/roles.go`: add capability key `logs.view` to `CapabilityGroups`; the backfill
  loop defaults missing keys to "none" for persisted custom roles; map built-ins so
  owner/admin/operator grant it.
- `auth.go` `canViewLogs`: make it **strictly additive** —
  `canWrite(r) OR hasCapability(r, "logs.view")` (small `hasCapability` reading the role's
  capability map off `UserFromContext`). Only ever *expands* access (lets a viewer-tier
  custom role be granted logs); never revokes operator/admin. All log paths (StreamLogs,
  StreamMultiLogs, project logs, the item-3 grep) funnel through `canViewLogs`, so they
  inherit automatically.
- Frontend Roles UI auto-renders the new capability; expose `AuthService.canViewLogs()`
  (capability OR write) so the logs `denied` gate matches reality.

**Tests:** `roles_test.go` — `logs.view` present, backfilled, default-none; built-ins map as
intended. Extend `TestCanWriteAndIsAdmin` / `websocket_test.go` — viewer **with** `logs.view`
passes `canViewLogs`; without, fails; operator/admin pass regardless (regression: no
revocation). Frontend — `AuthService.canViewLogs` spec; denied panel toggles correctly.

### 6. JSON log rendering Phase 2 — expand + field chips — **M/L** *(independent; do last)*

**Problem (verified):** Phase 1 (`parseStructured`, `logs-format.ts:84`) renders a JSON line
as level + message + dimmed `key=value` tail on ONE fixed-height row. The stream uses
`CdkVirtualScrollViewport` with **fixed `itemSize=19`** (`logs-page.component.ts:84`) and
`scrollToBucket`/`jumpToBottom` depend on `scrollToIndex`. Variable-height inline expansion
would break that math. Note `parseStructured` currently *discards* the parsed object — Phase
2 needs the field map.

**Recommended approach — detail DRAWER, not inline expand (protects virtual scroll):**
- `logs-format.ts`: have `parseStructured` (or a sibling) also return the field map
  `fields: Record<string, unknown>` (it already parses `obj`; just stop throwing it away).
- `LogLine` (`:29`): add optional `fields?: Record<string, unknown>` populated in `makeLine`
  only for structured lines (bounded by `MAX_LINES`, cheap), OR lazily re-parse the raw line
  on click. Prefer lazy re-parse to keep per-line memory flat.
- Click a JSON row → open a right-side **detail drawer** (reuse the existing off-canvas
  drawer pattern already used for the mobile sources panel) showing pretty-printed JSON with
  copyable values and clickable **field chips**.
- A field chip `key=value` → appends to `filterText` (regex-escaped when `useRegex`), so it
  filters the live stream using the machinery that already exists. `itemSize` untouched.
- **Rejected alternatives:** (A) inline expand with `cdk autosize` — breaks
  `scrollToIndex`/`jumpToBottom`; (C) hover popover — no room for chips + copy on mobile.

**Tests:** `logs-format.spec.ts` — `parseStructured` returns `fields`; field-chip → filter
string is regex-safe. Frontend spec — drawer opens for a JSON line, closed for plain;
clicking a chip sets `filterText`; `itemSize`/`scrollToIndex` unchanged.

---

## Recommended sequence

0. **P0 `new_issue` validator fix** — now, trivial, unblocks a shipped feature.
1. **Item 4 `error_rate`** (S/M) — pairs with the P0 fix (same `alerts.go`/`validAlertType`),
   reuses `diag_buckets`, completes the Insights→Alerts story. Fast, high value, low risk.
2. **Item 1 WS keepalive** (M) — build-once foundation; hardens all 8 sockets incl. the
   `/ws/events` firehose and the multiplexed logs socket item 2 extends. Introduces the only
   new concurrency. Doing it before item 2 means item 2 edits an already-wrapped handler.
3. **Item 2 restart-resubscribe** (M) — same surfaces just opened (`StreamMultiLogs` /
   `followLogs` / `websocket.service.ts` / `logs-page`). Keep the multiplexed-logs work in one
   window.
4. **Item 3 history grep** (M) — self-contained REST endpoint, must gate via `canViewLogs`
   (sets up item 5).
5. **Item 5 logs-RBAC** (M) — one-touch policy change *once* every reader funnels through
   `canViewLogs` (StreamLogs, StreamMultiLogs, project logs, grep), so the capability lands
   everywhere at once.
6. **Item 6 JSON Phase 2** (M/L) — independent frontend; do when the backend cluster is done.

## Cross-cutting (build once)

- **`wsConn` + `startKeepalive`** (item 1) — serialized writes + liveness for every handler.
- **`canViewLogs` as the single log gate** — item 3's grep calls it; item 5 upgrades it once;
  all readers inherit. Preserve the existing design comment.
- **Shared Docker-log line reader** — `StreamLogs`, `followLogs`, and the item-3 grep all do
  `ContainerLogs → io.Pipe → stdcopy → bufio → splitLogTimestamp → lineLevel`. Factor ONE
  iterator helper during item 3 and reuse it (keeps level classification identical).
- **Single alert-type source of truth** — back `validAlertType` + the `evalAlertRule` switch
  with one canonical list so `new_issue`/`error_rate` can't drift from the dropdown again.
- **`diag_buckets` query pattern** — item 4 reuses the hour-bucket SUM + cutoff helpers from
  `DiagStatsSummary`; no new table/sink/migration.

## Top risks

- **Don't regress honest-connection-state** (items 1 & 2): a healthy 54s ping must never flip
  `state$` (browsers auto-pong, so a live socket never closes). Keep `pingPeriod < pongWait`
  with margin; assert `state$` stays `live` across a ping interval; deploy-eyeball the events
  firehose + logs page after rollout.
- **Don't regress the shipped virtual-scroll / OnPush work** (items 3 & 6): render grep
  results and JSON detail in a SEPARATE drawer/signal, drive resubscribe through the 250ms
  RealtimeService debounce, never touch `itemSize`/`trackByUid`/`segCache`.
- **gorilla concurrent-writer panic** (item 1): the wrapper mutex must cover every write;
  `go test -race`; grep for any `.Conn.WriteMessage` after the change.
- **logs-RBAC must never REVOKE** (item 5): make `canViewLogs` strictly additive; regression
  test that operator/admin keep logs regardless of the key.
- **Server-side log-read amplification** (items 2 & 3): hard-cap grep scanned-lines + matches
  + timeout; bound reattach retries/backoff and only when the container is observed running;
  the existing `maxMultiLogSubs=200` cap still applies.

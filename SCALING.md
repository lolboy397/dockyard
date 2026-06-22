# Scaling plan

Hardening Dockyard for bigger single hosts (hundreds of containers) and several
concurrent users. None of these are bugs — they're headroom. Ordered by impact
(what degrades *everyone's* experience first).

Status: ☐ not started · ◑ in progress · ☑ done

## Phase 1 — Shared, capped stats collector ☑
The `/ws/allstats` feed collected stats **per WebSocket connection** every 3s, with
one `ContainerStats` goroutine per container and no concurrency cap. M users ×
N containers = M×N daemon calls every 3s.
- One **shared** collection loop fans out to all subscribers (M users → 1 collection). ☑
- **Concurrency semaphore** caps simultaneous `ContainerStats` calls (`statsContainerConcurrency = 24`). ☑
- Loop runs only while ≥1 subscriber is connected. ☑

Done: `statsHub` in `websocket.go` (shared collect loop + latest-wins fan-out +
subscriber-gated lifecycle); `/ws/allstats` wire format unchanged. Tested:
`TestStatsHubFanOutAndLifecycle`.

## Phase 2 — Database read concurrency ☑
`SetMaxOpenConns(1)` serialized every read and write on one connection, and every
authenticated request does a session lookup through it. WAL already allows
concurrent reads.
- Split into a read pool (`MaxOpenConns = 8`, `query_only`) + the single-writer
  handle. ☑

Done: `DB.read` pool routes all 49 `Query`/`QueryRow` reads; writes/transactions
stay on `conn` (single writer, so no write-lock contention). In-memory DBs share
one handle (per-connection isolation). Tested: `TestReadPoolSplitAndConsistency`
(separate pool, read-after-write consistency, concurrent reads, query_only guard).

## Phase 3 — Shared ContainerList cache ☑
Many handlers do a full `ContainerList` per request, and the realtime UI refetches
on every Docker event — so M users on a busy host = M× redundant scans in the same
instant.
- Short-TTL (1.5s) shared, mutex-guarded cache, invalidated by the event stream. ☑

Done: `containerCache` (`containercache.go`) with double-checked per-key locking
(no thundering herd), errors never cached. Applied to the high-traffic list
endpoints — Containers list, Stacks list + Get, project port enrichment
(`livePortIndex`). **Left direct on purpose:** port-conflict checks
(`usedHostPorts`), alerts, watcher (correctness/low-frequency). Invalidated on real
container lifecycle events in the Docker event consumer (`main.go`), not on
exec/health noise. Tested: `TestContainerCache`.

## Phase 4 — Frontend rendering (virtualization) ◑
Container/event lists rendered every row, so hundreds of rows meant hundreds of
DOM nodes checked each change-detection cycle. Chosen approach: **frontend
virtualization first** (no API change), with server-side pagination left as a
later option only if payload size becomes the issue.
- Containers list: CDK `cdk-virtual-scroll-viewport` renders only visible rows
  (`itemSize: 42`, exact under the global `box-sizing: border-box`), `trackBy: Id`. ☑
- Events list already caps render at 200 rows; OnPush deferred (risky on the
  complex container component). ☐ (optional follow-up)

Note: build-verified; the layout change (viewport becomes the table's internal
scroller) should be eyeballed on the Containers page after deploy.

## Phase 5 — Event ingestion-time filtering + batching ☐
Every Docker event is INSERTed (mute filters are read-time), serialized on the one
DB connection; a churny host produces a high write rate + table growth.
- Optional ingestion-time drop for muted kinds; batched inserts; configurable
  retention.

## Phase 6 — Structural HA / horizontal scale ☐ (deferred)
Single stateful backend (local SQLite + in-memory hubs/cancels) — no failover or
multi-replica. Out of scope unless multi-host / redundancy is actually needed
(would mean externalizing state, e.g. Postgres).

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

## Phase 2 — Database read concurrency ☐
`SetMaxOpenConns(1)` serializes every read and write on one connection, and every
authenticated request does a session lookup through it. WAL already allows
concurrent reads.
- Split into a read pool (`MaxOpenConns > 1`) + a dedicated single-writer handle,
  or cache the per-request session lookup.

## Phase 3 — Shared ContainerList cache ☐
Many handlers do a full `ContainerList(All:true)` per request (stacks, project port
enrichment, port checks, alerts, logs). Polling × users multiplies redundant scans.
- Short-TTL (~1–2s) shared, mutex-guarded cache, invalidated by the existing event
  stream.

## Phase 4 — Pagination + frontend rendering ☐
Container/event lists are fetched and rendered whole; default change detection
re-runs list getters every cycle.
- Server-side pagination; virtual scroll / `OnPush` / `trackBy`.

## Phase 5 — Event ingestion-time filtering + batching ☐
Every Docker event is INSERTed (mute filters are read-time), serialized on the one
DB connection; a churny host produces a high write rate + table growth.
- Optional ingestion-time drop for muted kinds; batched inserts; configurable
  retention.

## Phase 6 — Structural HA / horizontal scale ☐ (deferred)
Single stateful backend (local SQLite + in-memory hubs/cancels) — no failover or
multi-replica. Out of scope unless multi-host / redundancy is actually needed
(would mean externalizing state, e.g. Postgres).

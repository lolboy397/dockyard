import { Observable, Subscription } from 'rxjs';
import { take } from 'rxjs/operators';

/**
 * Optimistic-UI action helper.
 *
 * Applies a UI change immediately, dispatches the mutation, and rolls back on
 * failure. The request fires exactly once. Reconciliation is intentionally left
 * to the caller:
 *  - Docker resources (containers/images/networks/volumes/stacks) already refetch
 *    via RealtimeService's debounced /ws/events firehose, so they pass no
 *    `onSuccess` — the realtime refetch silently overwrites the optimistic patch
 *    with authoritative state ~250 ms later.
 *  - Non-Docker resources (alerts, users, roles, event-mute-rules, registry,
 *    backups) have no realtime events. Reconcile via `onSuccess` ONLY when the
 *    result is NOT client-predictable — a create that receives a server-assigned
 *    id, or a multi-field edit the server may normalize — by passing
 *    `onSuccess: () => this.load()` or merging the server response. A
 *    client-predictable change (a boolean toggle, a single-item delete) already
 *    equals the server result once the request succeeds, so no refetch is needed;
 *    a full reload would only flash a loading state. On HTTP error `rollback`
 *    always restores the prior state regardless.
 *
 * The `apply`/`rollback` closures keep the helper agnostic to how state is stored:
 * a signal list uses `signal.update(...)`, a plain component uses field assignment
 * (see `optimisticPatch` for the common object-field case).
 */
export interface OptimisticAction {
  /** Apply the optimistic UI change now (signal `.update()` or field assignment). */
  apply: () => void;
  /** Inverse of `apply` — restore the prior UI state. Runs on HTTP error. */
  rollback: () => void;
  /** The mutation request. Subscribed once (`take(1)`). */
  request$: Observable<unknown>;
  /**
   * Optional in-flight guard. While the request is pending `host[key]` is `true`
   * (bind `[disabled]` to it); a second dispatch is ignored while it is set,
   * which prevents double-submit.
   */
  busy?: { host: any; key: string };
  /** Called after rollback on HTTP error — surface a toast here. */
  onError?: (err: unknown) => void;
  /** Called on HTTP success — reconcile non-realtime resources (e.g. `this.load()`). */
  onSuccess?: () => void;
}

/**
 * Run an optimistic action. Returns the Subscription so callers may track/tear it
 * down if needed; most can ignore the return value.
 */
export function optimistic(action: OptimisticAction): Subscription {
  const { apply, rollback, request$, busy, onError, onSuccess } = action;

  // Dedup: ignore a re-dispatch while the same marker is already in flight.
  if (busy && busy.host[busy.key]) return Subscription.EMPTY;
  if (busy) busy.host[busy.key] = true;

  apply();

  return request$.pipe(take(1)).subscribe({
    next: () => {
      if (busy) busy.host[busy.key] = false;
      onSuccess?.();
    },
    error: (err) => {
      rollback();
      if (busy) busy.host[busy.key] = false;
      onError?.(err);
    },
  });
}

/**
 * Convenience for the common case: patch fields on a plain object (a settings
 * object, or a row rendered without a signal). Snapshots only the patched keys
 * and restores them on error.
 *
 *   optimisticPatch(this.watch, { auto_update: !this.watch.auto_update },
 *     this.docker.upsertWatchedImage(next),
 *     { busy: { host: this, key: 'watchBusy' }, onError: () => this.notify.error('…') });
 *
 * NOTE: for signal-backed lists, mutating a row in place will not trigger the
 * signal — use `optimistic()` with a `signal.update(...)` apply/rollback instead.
 */
export function optimisticPatch<T extends object>(
  target: T,
  patch: Partial<T>,
  request$: Observable<unknown>,
  opts: Pick<OptimisticAction, 'busy' | 'onError' | 'onSuccess'> = {},
): Subscription {
  const snapshot = {} as Partial<T>;
  (Object.keys(patch) as (keyof T)[]).forEach((k) => { snapshot[k] = target[k]; });
  return optimistic({
    apply: () => Object.assign(target, patch),
    rollback: () => Object.assign(target, snapshot),
    request$,
    ...opts,
  });
}

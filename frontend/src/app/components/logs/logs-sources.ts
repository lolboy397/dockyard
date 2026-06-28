// Pure source-list reconciliation for the Logs page, kept framework-free so the
// add / remove / recreate logic is unit-testable in isolation (see
// logs-sources.spec.ts) rather than only through the live component.

/** Minimal container shape the reconciler needs (a subset of ContainerSummary). */
export interface ReconcileContainer { Id: string; Names: string[]; State: string; }

/** A log-source row (mirrors LogSource in the component). */
export interface ReconcileSource { id: string; name: string; color: string; on: boolean; }

export interface ReconcilePlan {
  /** The new source list, in container order, with selection carried over. */
  next: ReconcileSource[];
  /** Ids whose container vanished — unsubscribe + drop. */
  unsubscribe: string[];
  /** Ids new since the previous list AND active — subscribe (fresh tail). Existing
   *  follows are deliberately excluded so their since-resume point isn't disturbed. */
  subscribe: string[];
}

function sourceName(c: ReconcileContainer): string {
  return c.Names[0]?.replace('/', '') ?? c.Id.slice(0, 8);
}

/**
 * Diffs the current source list against the live container list and returns the
 * next list plus the subscribe / unsubscribe actions.
 *
 * Selection is preserved by id; a container that was recreated (new id, same name)
 * inherits the on/off of the same-named source that just vanished — so a
 * `compose up --force-recreate` doesn't silently drop a tail the operator was
 * watching. Only genuinely-new active ids are returned to subscribe: re-subscribing
 * an existing follow would clear its since-resume point and re-dump tail history.
 */
export function planSourceReconcile(
  prev: ReconcileSource[],
  containers: ReconcileContainer[],
  savedOnIds: Set<string> | null,
  palette: string[],
): ReconcilePlan {
  const prevById = new Map(prev.map(s => [s.id, s]));
  const prevByName = new Map(prev.map(s => [s.name, s]));
  const prevIds = new Set(prevById.keys());
  const nextIds = new Set(containers.map(c => c.Id));

  const unsubscribe = prev.filter(s => !nextIds.has(s.id)).map(s => s.id);

  const next: ReconcileSource[] = containers.map((c, i) => {
    const name = sourceName(c);
    const prevSrc = prevById.get(c.Id);
    let on: boolean;
    if (prevSrc) {
      on = prevSrc.on;
    } else {
      const gone = prevByName.get(name);
      on = gone && !nextIds.has(gone.id) ? gone.on
        : savedOnIds ? savedOnIds.has(c.Id)
          : c.State === 'running';
    }
    return { id: c.Id, name, color: prevSrc?.color ?? palette[i % palette.length], on };
  });

  const subscribe = next.filter(s => s.on && !prevIds.has(s.id)).map(s => s.id);
  return { next, unsubscribe, subscribe };
}

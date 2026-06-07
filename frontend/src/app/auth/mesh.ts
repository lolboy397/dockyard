/**
 * Mesh-background hooks — light up the orchestration-grid container nearest a
 * focused field, exactly as the design-system prototype does. The animated
 * background publishes `window.DockyardMesh`; these helpers are no-ops until it
 * mounts.
 */
export interface DockyardMeshApi {
  setSource(x: number | null, y?: number): void;
  burst(x: number, y: number, n?: number): void;
}

declare global {
  interface Window {
    DockyardMesh?: DockyardMeshApi;
  }
}

export function meshFocus(e: FocusEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const r = target.getBoundingClientRect();
  if (window.DockyardMesh) window.DockyardMesh.setSource(r.left + r.width / 2, r.top + r.height / 2);
}

export function meshBlur(): void {
  if (window.DockyardMesh) window.DockyardMesh.setSource(null);
}

/** Fire a packet burst from the mesh nodes nearest a button element. */
export function meshBurstFrom(el: Element | null, n = 6): void {
  if (!el || !window.DockyardMesh) return;
  const r = el.getBoundingClientRect();
  window.DockyardMesh.burst(r.left + r.width / 2, r.top + r.height / 2, n);
}

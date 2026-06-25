import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { PruneResult } from '../models/docker.models';

/** One selectable scope in the prune dialog (e.g. "Dangling only" vs "All unused"). */
export interface PruneScopeOption {
  /** maps to the backend ?all flag */
  all: boolean;
  /** segment label */
  label: string;
  /** estimated number of items this scope will remove */
  count: number;
  /** estimated bytes reclaimed (0 = not shown, e.g. containers/networks) */
  bytes: number;
  /** short hint under the count */
  note?: string;
  /** mark this scope as the aggressive one (shows the warning) */
  danger?: boolean;
}

export interface PruneConfig {
  kind: 'images' | 'containers' | 'volumes' | 'networks';
  /** dialog heading, e.g. "Prune images" */
  title: string;
  /** singular noun for counts, e.g. "image" → "3 images" */
  noun: string;
  /** one scope (no toggle) or two (segmented toggle) */
  scopes: PruneScopeOption[];
  /** warning copy shown when a danger scope is selected */
  warning?: string;
  /** runs the prune for the chosen scope and returns the itemized result */
  run: (all: boolean) => Observable<PruneResult>;
}

/**
 * Drives the shared 3-phase prune dialog (review → running → summary). Mount
 * <app-prune-dialog> once in app.component.html; any component (and the command
 * palette) calls open() to get a consistent, itemized prune with real feedback.
 *
 *   const changed = await this.pruneDialog.open({ ... });
 *   if (changed) this.load();   // reload only if something was removed
 */
@Injectable({ providedIn: 'root' })
export class PruneDialogService {
  readonly request$ = new Subject<{ config: PruneConfig; resolve: (changed: boolean) => void }>();

  /** Resolves to true if anything was removed (so the caller can reload). */
  open(config: PruneConfig): Promise<boolean> {
    return new Promise(resolve => this.request$.next({ config, resolve }));
  }
}

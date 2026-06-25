import { Injectable, signal } from '@angular/core';

/**
 * Single source of truth for the phone/tablet breakpoint, so list components can
 * swap their table for a card layout via `responsive.isMobile()`. Centralising it
 * here (one guarded matchMedia listener for the whole app) avoids per-component
 * boilerplate and is SSR/test-safe.
 */
@Injectable({ providedIn: 'root' })
export class ResponsiveService {
  readonly isMobile = signal(false);

  constructor() {
    if (typeof matchMedia === 'undefined') return;
    const mql = matchMedia('(max-width: 820px)');
    this.isMobile.set(mql.matches);
    mql.addEventListener('change', (e) => this.isMobile.set(e.matches));
  }
}

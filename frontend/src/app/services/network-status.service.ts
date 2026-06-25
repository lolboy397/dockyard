import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * Tracks browser connectivity for the offline banner and to trigger a resync
 * when the device comes back online (e.g. after the phone leaves a tunnel).
 */
@Injectable({ providedIn: 'root' })
export class NetworkStatusService {
  readonly isOnline = signal(navigator.onLine);
  /** Emits when connectivity is regained so views can refetch. */
  readonly reconnected$ = new Subject<void>();

  constructor() {
    window.addEventListener('online', () => {
      this.isOnline.set(true);
      this.reconnected$.next();
    });
    window.addEventListener('offline', () => this.isOnline.set(false));
  }
}

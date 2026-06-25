import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';

/**
 * Watches the service worker for a newly-deployed version and exposes an
 * `updateReady` flag the shell turns into a dismissable "Update available"
 * banner. The update is applied on the user's command (never a forced reload
 * over a dirty form). A wedged/unrecoverable worker self-heals on next load.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private swUpdate = inject(SwUpdate);
  readonly updateReady = signal(false);

  init(): void {
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => this.updateReady.set(true));

    this.swUpdate.unrecoverable.subscribe(() => this.recover());
  }

  /** Activate the downloaded version and reload. The caller is responsible for
   *  guarding against in-progress work (open modal / dirty form). */
  applyUpdate(): void {
    this.swUpdate.activateUpdate()
      .then(() => document.location.reload())
      .catch(() => this.updateReady.set(false)); // failed to swap — clear the banner; next load retries
  }

  /** Clear caches and hard-reload to recover a corrupted service worker state. */
  private async recover(): Promise<void> {
    await clearAllCaches();
    document.location.reload();
  }
}

/** Best-effort clear of all Cache Storage entries (also used on logout). */
export async function clearAllCaches(): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore — cache clear is best-effort */
  }
}

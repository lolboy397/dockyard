import { Injectable, signal } from '@angular/core';

/**
 * Single source of truth for whether Dockyard is running as an installed,
 * standalone PWA (versus a normal browser tab). Used to suppress install
 * prompts, switch the bottom tab bar to primary navigation, etc.
 */
@Injectable({ providedIn: 'root' })
export class PwaModeService {
  readonly isStandalone = signal(this.detect());

  constructor() {
    // Android can transition display-mode live; iOS cannot, but keep it in sync.
    const mq = window.matchMedia('(display-mode: standalone)');
    mq.addEventListener?.('change', (e) => this.isStandalone.set(e.matches || this.iosStandalone()));
    window.addEventListener('appinstalled', () => this.isStandalone.set(true));
  }

  private detect(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches || this.iosStandalone();
  }

  private iosStandalone(): boolean {
    return (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  }
}

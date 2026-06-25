import { Injectable, signal } from '@angular/core';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Captures Android/Chromium's `beforeinstallprompt` so we can offer install via
 * our own UI (the native mini-infobar is suppressed). iOS Safari fires no such
 * event — the install banner falls back to manual "Add to Home Screen" guidance.
 */
@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private deferred: BeforeInstallPromptEvent | null = null;
  readonly canInstall = signal(false);

  constructor() {
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault();
      this.deferred = e as BeforeInstallPromptEvent;
      this.canInstall.set(true);
    });
    window.addEventListener('appinstalled', () => {
      this.deferred = null;
      this.canInstall.set(false);
    });
  }

  async prompt(): Promise<void> {
    if (!this.deferred) return;
    await this.deferred.prompt();
    try { await this.deferred.userChoice; } catch { /* user dismissed */ }
    this.deferred = null;
    this.canInstall.set(false);
  }
}

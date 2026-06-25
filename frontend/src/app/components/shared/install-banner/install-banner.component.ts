import { Component, computed, signal } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { PwaModeService } from '../../../services/pwa-mode.service';
import { InstallPromptService } from '../../../services/install-prompt.service';

const DISMISS_KEY = 'dy_install_dismissed';

/**
 * Bottom banner inviting the user to install the PWA. On Android/Chromium it
 * triggers the captured native prompt; on iOS Safari (which has no prompt) it
 * shows manual "Add to Home Screen" guidance. Hidden once installed (standalone)
 * or after the user dismisses it.
 */
@Component({
  selector: 'dy-install-banner',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (visible()) {
      <div class="install-banner" role="dialog" aria-label="Install Dockyard">
        <div class="ib-icon"><dy-icon name="box" [size]="20"></dy-icon></div>
        <div class="ib-text">
          @if (canPrompt()) {
            <strong>Install Dockyard</strong>
            <span>Add it to your home screen for a full-screen, app-like experience.</span>
          } @else {
            <strong>Add to Home Screen</strong>
            <span>Tap <dy-icon name="share" [size]="13" class="ib-inline"></dy-icon> Share, then <em>Add to Home Screen</em>.</span>
          }
        </div>
        @if (canPrompt()) {
          <button class="ib-install" type="button" (click)="install()">Install</button>
        }
        <button class="ib-close" type="button" (click)="dismiss()" aria-label="Dismiss">
          <dy-icon name="x" [size]="16"></dy-icon>
        </button>
      </div>
    }
  `,
  styles: [`
    .install-banner {
      position: fixed; left: 12px; right: 12px;
      bottom: calc(12px + env(safe-area-inset-bottom));
      z-index: 250;
      display: flex; align-items: center; gap: 12px;
      padding: 12px 14px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      box-shadow: 0 16px 48px rgba(0,0,0,0.45);
      animation: ib-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    /* Clear the phone bottom tab bar (≤820px) so the banner doesn't overlap it. */
    @media (max-width: 820px) {
      .install-banner { bottom: calc(var(--bottom-tabs-h) + 12px); }
    }
    @keyframes ib-in { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }
    .ib-icon {
      flex: none; display: grid; place-items: center;
      width: 38px; height: 38px; border-radius: var(--r-md);
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent);
    }
    .ib-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .ib-text strong { font-size: 13px; }
    .ib-text span { font-size: 12px; color: var(--fg-muted); }
    .ib-inline { vertical-align: -2px; }
    .ib-install {
      flex: none; min-height: 36px; padding: 0 14px;
      border: 0; border-radius: var(--r-md);
      background: var(--accent); color: #04181D; font-weight: 600; font-size: 13px;
      cursor: pointer;
    }
    .ib-close {
      flex: none; display: grid; place-items: center;
      width: 32px; height: 32px; border: 0; border-radius: var(--r-md);
      background: transparent; color: var(--fg-muted); cursor: pointer;
    }
    .ib-close:hover { background: var(--bg-hover); color: var(--fg); }
    @media (max-width: 480px) { .ib-text span { display: none; } }
  `],
})
export class InstallBannerComponent {
  private dismissed = signal(this.readDismissed());
  private readonly iosSafari = this.detectIosSafari();

  readonly canPrompt = computed(() => this.installer.canInstall());
  readonly visible = computed(() =>
    !this.pwa.isStandalone() && !this.dismissed() && (this.installer.canInstall() || this.iosSafari)
  );

  constructor(private pwa: PwaModeService, private installer: InstallPromptService) {}

  install(): void { void this.installer.prompt(); }

  dismiss(): void {
    // iOS private mode throws on setItem; keep the in-memory flag so the banner
    // stays hidden for the session even if persistence fails.
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* quota / private mode */ }
    this.dismissed.set(true);
  }

  private readDismissed(): boolean {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  }

  private detectIosSafari(): boolean {
    const ua = navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS 13+
    // Only real Safari can Add to Home Screen — require a Safari token and exclude
    // other iOS browsers AND in-app WebViews (Mail/X/Slack/Brave/DDG), where the
    // Share → Add-to-Home-Screen flow doesn't exist. WebViews also lack SW.
    const isSafari = isIos && /safari\//i.test(ua) && !/crios|fxios|edgios|opios|brave/i.test(ua);
    return isSafari && 'serviceWorker' in navigator;
  }
}

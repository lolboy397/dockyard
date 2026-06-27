import { Component, OnInit, signal, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { AuthService } from '../../auth/auth.service';
import { NotificationService } from '../../services/notification.service';

/** The signed-in user's own account page. Currently hosts the Security section
 *  (two-factor / TOTP enrollment + management). */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account.component.html',
})
export class AccountComponent implements OnInit {
  private auth = inject(AuthService);
  private notify = inject(NotificationService);

  readonly user = this.auth.user;
  readonly enabled = signal(false);
  readonly remaining = signal(0);
  readonly loading = signal(true);

  // Enrollment state.
  readonly setup = signal<{ secret: string; otpauth_url: string } | null>(null);
  readonly code = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly backupCodes = signal<string[] | null>(null);

  // Disable state.
  readonly disabling = signal(false);
  readonly disablePassword = signal('');
  readonly disableError = signal<string | null>(null);

  ngOnInit(): void { this.refresh(); }

  private refresh(): void {
    this.loading.set(true);
    this.auth.twoFactorStatus().subscribe({
      next: s => { this.enabled.set(s.enabled); this.remaining.set(s.backup_codes_remaining); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  /** Group the base32 secret into 4-char blocks for legible manual entry. */
  prettySecret(s: string): string { return (s.match(/.{1,4}/g) || []).join(' '); }

  beginSetup(): void {
    this.busy.set(true); this.error.set(null);
    this.auth.twoFactorSetup().subscribe({
      next: r => { this.setup.set(r); this.code.set(''); this.busy.set(false); },
      error: e => { this.error.set(e?.error?.error || 'Could not start setup.'); this.busy.set(false); },
    });
  }

  confirm(): void {
    const c = this.code().trim();
    if (c.length < 6 || this.busy()) return;
    this.busy.set(true); this.error.set(null);
    this.auth.twoFactorConfirm(c).subscribe({
      next: r => {
        this.backupCodes.set(r.backup_codes);
        this.setup.set(null);
        this.busy.set(false);
        this.refresh();
        this.notify.success('Two-factor authentication enabled');
      },
      error: e => { this.error.set(e?.error?.error || 'That code didn’t match. Try again.'); this.busy.set(false); },
    });
  }

  cancelSetup(): void { this.setup.set(null); this.code.set(''); this.error.set(null); }
  dismissBackup(): void { this.backupCodes.set(null); }

  copySecret(): void {
    const s = this.setup(); if (!s) return;
    try { navigator.clipboard?.writeText(s.secret); this.notify.success('Setup key copied'); } catch { /* clipboard unavailable */ }
  }

  copyBackup(): void {
    const codes = this.backupCodes(); if (!codes) return;
    try { navigator.clipboard?.writeText(codes.join('\n')); this.notify.success('Backup codes copied'); } catch { /* clipboard unavailable */ }
  }

  beginDisable(): void { this.disabling.set(true); this.disablePassword.set(''); this.disableError.set(null); }
  cancelDisable(): void { this.disabling.set(false); this.disablePassword.set(''); this.disableError.set(null); }

  confirmDisable(): void {
    const pw = this.disablePassword();
    if (!pw || this.busy()) return;
    this.busy.set(true); this.disableError.set(null);
    this.auth.twoFactorDisable(pw).subscribe({
      next: () => {
        this.busy.set(false);
        this.disabling.set(false);
        this.refresh();
        this.notify.success('Two-factor authentication disabled');
      },
      error: e => { this.disableError.set(e?.error?.error || 'Could not disable two-factor.'); this.busy.set(false); },
    });
  }
}

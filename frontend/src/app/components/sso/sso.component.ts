import { Component, OnInit, signal, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { AuthService } from '../../auth/auth.service';
import { NotificationService } from '../../services/notification.service';
import { OIDCConfig } from '../../auth/auth.models';

/** Admin page: configure the single OpenID Connect provider for SSO. */
@Component({
  selector: 'app-sso',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sso.component.html',
})
export class SsoComponent implements OnInit {
  private auth = inject(AuthService);
  private notify = inject(NotificationService);

  readonly cfg = signal<OIDCConfig | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly hasSecret = signal(false);
  readonly roles = ['viewer', 'developer', 'maintainer', 'admin'];

  get callbackUrl(): string { return `${window.location.origin}/api/v1/auth/sso/callback`; }

  ngOnInit(): void {
    this.auth.getSsoConfig().subscribe({
      next: c => { this.hasSecret.set(!!c.has_secret); this.cfg.set({ ...c, client_secret: '' }); this.loading.set(false); },
      error: () => { this.cfg.set(this.blank()); this.loading.set(false); },
    });
  }

  private blank(): OIDCConfig {
    return {
      enabled: false, issuer_url: '', client_id: '', client_secret: '',
      button_label: 'Sign in with SSO', allowed_domains: '', default_role: 'viewer', auto_provision: true,
    };
  }

  patch<K extends keyof OIDCConfig>(key: K, value: OIDCConfig[K]): void {
    const c = this.cfg(); if (!c) return;
    this.cfg.set({ ...c, [key]: value });
  }

  copyCallback(): void {
    try { navigator.clipboard?.writeText(this.callbackUrl); this.notify.success('Callback URL copied'); } catch { /* clipboard unavailable */ }
  }

  save(): void {
    const c = this.cfg(); if (!c || this.saving()) return;
    this.saving.set(true);
    this.auth.saveSsoConfig(c).subscribe({
      next: saved => {
        this.saving.set(false);
        this.hasSecret.set(!!saved.has_secret);
        this.cfg.set({ ...saved, client_secret: '' });
        this.auth.refreshStatus().subscribe();
        this.notify.success('SSO settings saved');
      },
      error: e => { this.saving.set(false); this.notify.error(e?.error?.error || 'Could not save SSO settings'); },
    });
  }
}

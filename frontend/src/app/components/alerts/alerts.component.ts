import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { ModalComponent } from '../shared/modal/modal.component';
import { DockerService, AlertRule } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ResponsiveService } from '../../services/responsive.service';
import { AuthService } from '../../auth/auth.service';
import { optimistic } from '../../helpers/optimistic.helper';

/** Alerts — manage host-threshold / container-exited rules that notify in-app or via webhook. */
@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, ModalComponent],
  styleUrls: ['./alerts.component.scss'],
  templateUrl: './alerts.component.html',
})
export class AlertsComponent implements OnInit {
  rules = signal<AlertRule[]>([]);
  loading = signal(true);

  showNew = false;
  form = { name: '', type: 'host_cpu', threshold: 80, channel: 'in_app', webhook_url: '', enabled: true, forMinutes: 0 };

  constructor(
    public auth: AuthService,
    private docker: DockerService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
    public responsive: ResponsiveService,
  ) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.docker.listAlerts().subscribe({
      next: rs => { this.rules.set(rs); this.loading.set(false); },
      error: () => { this.loading.set(false); },
    });
  }

  condition(a: AlertRule): string {
    let base: string;
    switch (a.type) {
      case 'host_cpu':  base = `Host CPU ≥ ${a.threshold}%`; break;
      case 'host_mem':  base = `Host memory ≥ ${a.threshold}%`; break;
      case 'host_disk': base = `Host disk ≥ ${a.threshold}%`; break;
      case 'container_exited': base = 'A container exits'; break;
      case 'new_issue': base = a.threshold > 1 ? `${a.threshold}+ new Insights issues appear` : 'A new Insights issue appears'; break;
      default: base = a.type;
    }
    if (a.for_seconds && a.for_seconds > 0) {
      base += ` for ${this.formatDuration(a.for_seconds)}`;
    }
    return base;
  }

  private formatDuration(seconds: number): string {
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0)   return `${seconds / 60}m`;
    return `${seconds}s`;
  }

  openNew(): void {
    this.form = { name: '', type: 'host_cpu', threshold: 80, channel: 'in_app', webhook_url: '', enabled: true, forMinutes: 0 };
    this.showNew = true;
  }

  /** Reset the threshold to a sensible default when the rule type changes
   *  (percent for host rules vs a small issue count for new_issue). */
  onTypeChange(): void {
    if (this.form.type === 'new_issue') this.form.threshold = 1;
    else if (this.form.type.startsWith('host_')) this.form.threshold = 80;
  }

  create(): void {
    if (!this.form.name.trim()) return;
    const payload = {
      name: this.form.name,
      type: this.form.type,
      threshold: this.form.threshold,
      channel: this.form.channel,
      webhook_url: this.form.webhook_url,
      enabled: this.form.enabled,
      for_seconds: Math.max(0, Math.round((this.form.forMinutes || 0) * 60)),
    };
    this.docker.createAlert(payload).subscribe({
      next: () => { this.notify.success(`Alert "${this.form.name}" created`); this.showNew = false; this.load(); },
      error: e => this.notify.error(e?.error?.error || 'Failed to create alert'),
    });
  }

  toggleEnabled(a: AlertRule): void {
    const enabled = !a.enabled;
    // Optimistic: flip immediately; the server just persists the flag, so on
    // success the optimistic state is authoritative — no refetch needed.
    optimistic({
      apply: () => this.rules.update(rs => rs.map(r => r.id === a.id ? { ...r, enabled } : r)),
      rollback: () => this.rules.update(rs => rs.map(r => r.id === a.id ? { ...r, enabled: a.enabled } : r)),
      request$: this.docker.updateAlert(a.id, { ...a, enabled }),
      onError: e => this.notify.error((e as any)?.error?.error || 'Update failed'),
    });
  }

  async remove(a: AlertRule): Promise<void> {
    const ok = await this.confirm.confirm({ title: `Delete "${a.name}"?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    const snapshot = this.rules();
    optimistic({
      apply: () => this.rules.update(rs => rs.filter(r => r.id !== a.id)),
      rollback: () => this.rules.set(snapshot),
      request$: this.docker.deleteAlert(a.id),
      onSuccess: () => this.notify.success(`Deleted "${a.name}"`),
      onError: e => this.notify.error((e as any)?.error?.error || 'Delete failed'),
    });
  }
}

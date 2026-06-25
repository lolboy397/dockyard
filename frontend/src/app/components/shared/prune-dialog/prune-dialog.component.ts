import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { ModalComponent } from '../modal/modal.component';
import { IconComponent } from '../icon/icon.component';
import { PruneDialogService, PruneConfig, PruneScopeOption } from '../../../services/prune-dialog.service';
import { NotificationService } from '../../../services/notification.service';
import { PruneResult, PruneItem } from '../../../models/docker.models';

/**
 * Shared, 3-phase prune dialog (review → running → summary) driven by
 * PruneDialogService. Mount once in app.component.html.
 *
 * - REVIEW: pick a scope (e.g. dangling-only vs all-unused), see the estimate and
 *   any warning, confirm.
 * - RUNNING: spinner; dismissal is gated so the in-flight prune isn't abandoned.
 * - SUMMARY: itemized list of exactly what was removed and what was skipped (with
 *   the reason), plus one authoritative toast — never a silent success/failure.
 */
@Component({
  selector: 'app-prune-dialog',
  standalone: true,
  imports: [CommonModule, ModalComponent, IconComponent],
  templateUrl: './prune-dialog.component.html',
  styleUrls: ['./prune-dialog.component.scss'],
})
export class PruneDialogComponent implements OnInit, OnDestroy {
  visible = false;
  config: PruneConfig | null = null;
  phase: 'review' | 'running' | 'summary' = 'review';
  all = false;
  result: PruneResult | null = null;
  error: string | null = null;

  private resolve?: (changed: boolean) => void;
  private sub?: Subscription;
  private runSub?: Subscription;

  constructor(private svc: PruneDialogService, private notify: NotificationService) {}

  ngOnInit(): void {
    this.sub = this.svc.request$.subscribe(({ config, resolve }) => {
      this.config = config;
      this.resolve = resolve;
      this.phase = 'review';
      this.all = config.scopes[0]?.all ?? false;
      this.result = null;
      this.error = null;
      this.visible = true;
    });
  }

  ngOnDestroy(): void { this.sub?.unsubscribe(); this.runSub?.unsubscribe(); }

  get scope(): PruneScopeOption | undefined {
    return this.config?.scopes.find(s => s.all === this.all) ?? this.config?.scopes[0];
  }
  get hasToggle(): boolean { return (this.config?.scopes.length ?? 0) > 1; }
  get removed(): PruneItem[] { return this.result?.removed ?? []; }
  get skipped(): PruneItem[] { return this.result?.skipped ?? []; }

  select(all: boolean): void { if (this.phase === 'review') this.all = all; }

  start(): void {
    if (!this.config) return;
    this.phase = 'running';
    this.error = null;
    this.runSub = this.config.run(this.all).subscribe({
      next: (res) => { this.result = res; this.phase = 'summary'; this.announce(res); },
      error: (e) => {
        this.error = this.humanError(e);
        this.phase = 'summary';
        this.notify.error(`${this.config?.title ?? 'Prune'} failed`);
      },
    });
  }

  // Gate dismissal while the prune is in flight; otherwise resolve + close.
  onClose(): void {
    if (this.phase === 'running') return;
    const changed = (this.result?.removed.length ?? 0) > 0;
    this.visible = false;
    this.resolve?.(changed);
    this.resolve = undefined;
  }

  summaryLine(): string {
    const r = this.result;
    if (!r) return '';
    const n = r.removed.length;
    const parts = [`Removed ${n} ${this.plural(n)}`];
    if (r.reclaimed > 0) parts.push(`freed ${this.formatBytes(r.reclaimed)}`);
    if (r.skipped.length) parts.push(`skipped ${r.skipped.length}`);
    return parts.join(' · ');
  }

  confirmLabel(): string {
    const c = this.scope?.count ?? 0;
    return `Prune ${c} ${this.plural(c)}`;
  }

  plural(n: number): string {
    const noun = this.config?.noun ?? 'item';
    return n === 1 ? noun : noun + 's';
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) return '0 B';
    const gb = bytes / 1073741824;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / 1048576;
    if (mb >= 1) return `${mb.toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  private announce(res: PruneResult): void {
    if (res.removed.length === 0 && res.skipped.length === 0) {
      this.notify.info('Nothing needed removing');
      return;
    }
    let msg = `Removed ${res.removed.length} ${this.plural(res.removed.length)}`;
    if (res.reclaimed > 0) msg += ` · freed ${this.formatBytes(res.reclaimed)}`;
    if (res.skipped.length) msg += ` · ${res.skipped.length} skipped`;
    this.notify.success(msg);
  }

  private humanError(e: any): string {
    return e?.error?.error || e?.message || 'The prune could not be completed.';
  }
}

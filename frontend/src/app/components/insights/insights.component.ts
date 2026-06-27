import { Component, OnInit, OnDestroy, signal, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { DiagService, DiagGroup, DiagEvent, DiagStats } from '../../services/diag.service';
import { NotificationService } from '../../services/notification.service';
import { formatRelative } from '../logs/logs-format';

/** Admin "Insights" page — the issue feed for the in-house diagnostics store
 *  (backend 5xx/panics + frontend errors), grouped by fingerprint. */
@Component({
  selector: 'app-insights',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './insights.component.html',
})
export class InsightsComponent implements OnInit, OnDestroy {
  private diag = inject(DiagService);
  private notify = inject(NotificationService);

  readonly stats = signal<DiagStats | null>(null);
  readonly groups = signal<DiagGroup[]>([]);
  readonly loading = signal(true);
  readonly statusFilter = signal<string>('open');
  readonly sourceFilter = signal<string>('');

  readonly selected = signal<DiagGroup | null>(null);
  readonly events = signal<DiagEvent[]>([]);
  readonly eventsLoading = signal(false);

  private poll?: ReturnType<typeof setInterval>;
  private readonly nowTick = signal(0);

  readonly statuses = [
    { v: 'open', label: 'Open' },
    { v: 'resolved', label: 'Resolved' },
    { v: 'muted', label: 'Muted' },
    { v: '', label: 'All' },
  ];
  readonly sourceTabs = [
    { v: '', label: 'All' },
    { v: 'backend', label: 'Backend' },
    { v: 'frontend', label: 'Frontend' },
  ];

  ngOnInit(): void {
    this.load();
    this.poll = setInterval(() => { this.nowTick.update(n => n + 1); this.load(true); }, 10_000);
  }
  ngOnDestroy(): void { if (this.poll) clearInterval(this.poll); }

  load(silent = false): void {
    if (!silent) this.loading.set(true);
    this.diag.stats().subscribe({ next: s => this.stats.set(s), error: () => { /* ignore */ } });
    this.diag.groups(this.statusFilter(), this.sourceFilter()).subscribe({
      next: g => { this.groups.set(g || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  setStatusFilter(v: string): void { this.statusFilter.set(v); this.load(); }
  setSourceFilter(v: string): void { this.sourceFilter.set(v); this.load(); }

  select(g: DiagGroup): void {
    this.selected.set(g);
    this.eventsLoading.set(true);
    this.events.set([]);
    this.diag.events(g.fingerprint).subscribe({
      next: e => { this.events.set(e || []); this.eventsLoading.set(false); },
      error: () => this.eventsLoading.set(false),
    });
  }
  closeDetail(): void { this.selected.set(null); this.events.set([]); }

  setStatus(g: DiagGroup, status: 'open' | 'resolved' | 'muted', ev?: Event): void {
    ev?.stopPropagation();
    this.diag.setStatus(g.fingerprint, status).subscribe({
      next: () => {
        this.notify.success(status === 'open' ? 'Issue reopened' : `Issue ${status}`);
        if (this.selected()?.fingerprint === g.fingerprint) this.closeDetail();
        this.load(true);
      },
      error: () => this.notify.error('Could not update the issue'),
    });
  }

  rel(ts: string): string { this.nowTick(); return formatRelative(ts, ts, Date.now()); }

  prettyContext(c?: string): string {
    if (!c) return '';
    try { return JSON.stringify(JSON.parse(c), null, 2); } catch { return c; }
  }

  trackFp = (_: number, g: DiagGroup) => g.fingerprint;
  trackId = (_: number, e: DiagEvent) => e.id;
}

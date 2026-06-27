import { Component, OnInit, OnDestroy, signal, computed, ChangeDetectionStrategy, inject, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';
import { DiagService, DiagGroup, DiagEvent, DiagStats } from '../../services/diag.service';
import { NotificationService } from '../../services/notification.service';
import { formatRelative } from '../logs/logs-format';

type DotTone = 'running' | 'warn' | 'danger' | 'info' | 'idle' | 'accent';
interface LevelMeta { icon: string; label: string; tone: DotTone; }

const LEVEL: Record<string, LevelMeta> = {
  error: { icon: 'octagon-alert', label: 'Error', tone: 'danger' },
  warn: { icon: 'triangle-alert', label: 'Warning', tone: 'warn' },
  info: { icon: 'info', label: 'Info', tone: 'info' },
};
const SOURCE: Record<string, { icon: string; label: string }> = {
  backend: { icon: 'server', label: 'backend' },
  frontend: { icon: 'globe', label: 'frontend' },
};
const STATUS_LABEL: Record<string, string> = { open: 'Open', resolved: 'Resolved', muted: 'Muted' };

/** Admin "Insights" page — the issue feed for the in-house diagnostics store
 *  (backend 5xx/panics + frontend errors), grouped by fingerprint. */
@Component({
  selector: 'app-insights',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, StatusDotComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './insights.component.html',
})
export class InsightsComponent implements OnInit, OnDestroy {
  private diag = inject(DiagService);
  private notify = inject(NotificationService);
  private sanitizer = inject(DomSanitizer);

  readonly stats = signal<DiagStats | null>(null);
  /** ALL groups (server returns every fingerprint); status/source/search are
   *  applied client-side so the filter pills can show live counts. */
  readonly allGroups = signal<DiagGroup[]>([]);
  readonly loading = signal(true);
  readonly refreshing = signal(false);

  readonly statusFilter = signal<string>('open');
  readonly sourceFilter = signal<string>('');
  readonly search = signal<string>('');

  readonly selected = signal<DiagGroup | null>(null);
  readonly events = signal<DiagEvent[]>([]);
  readonly eventsLoading = signal(false);
  readonly copiedId = signal<string>('');

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

  /** The visible feed: status + source + text filter applied client-side. */
  readonly filtered = computed<DiagGroup[]>(() => {
    const st = this.statusFilter();
    const src = this.sourceFilter();
    const q = this.search().trim().toLowerCase();
    return this.allGroups().filter(g =>
      (st === '' || g.status === st) &&
      (src === '' || g.source === src) &&
      (!q || g.title.toLowerCase().includes(q) || (g.fingerprint || '').includes(q)),
    );
  });

  ngOnInit(): void {
    this.load();
    this.poll = setInterval(() => { this.nowTick.update(n => n + 1); this.load(true); }, 10_000);
  }
  ngOnDestroy(): void { if (this.poll) clearInterval(this.poll); }

  @HostListener('document:keydown.escape')
  onEsc(): void { if (this.selected()) this.closeDetail(); }

  load(silent = false): void {
    if (!silent) this.loading.set(true); else this.refreshing.set(true);
    this.diag.stats().subscribe({ next: s => this.stats.set(s), error: () => { /* ignore */ } });
    this.diag.groups('', '').subscribe({
      next: g => { this.allGroups.set(g || []); this.loading.set(false); this.refreshing.set(false); },
      error: () => { this.loading.set(false); this.refreshing.set(false); },
    });
  }

  setStatusFilter(v: string): void { this.statusFilter.set(v); }
  setSourceFilter(v: string): void { this.sourceFilter.set(v); }

  /** Count of groups in a given status (ignores source/search), for the pills. */
  statusCount(v: string): number {
    const g = this.allGroups();
    return v === '' ? g.length : g.filter(x => x.status === v).length;
  }

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

  copy(id: string): void {
    if (!id) return;
    try { navigator.clipboard?.writeText(id); } catch { /* clipboard unavailable */ }
    this.copiedId.set(id);
    setTimeout(() => { if (this.copiedId() === id) this.copiedId.set(''); }, 1200);
  }

  // ── view helpers ──────────────────────────────────────────────────────────
  lvl(level: string): LevelMeta { return LEVEL[level] ?? LEVEL['info']; }
  src(source: string): { icon: string; label: string } { return SOURCE[source] ?? { icon: 'circle', label: source }; }
  statusLabel(s: string): string { return STATUS_LABEL[s] ?? s; }

  /** Relative age "12s ago" / "just now" from an RFC3339 timestamp. */
  ago(ts: string): string {
    this.nowTick();
    const v = formatRelative(ts, ts, Date.now());
    return v === 'now' ? 'just now' : `${v} ago`;
  }

  codeClass(c: number): string { return c >= 500 ? 's5' : c >= 400 ? 's4' : c >= 200 ? 's2' : ''; }

  /** Split a stack trace into lines, flagging application frames (vs runtime/deps)
   *  so the template can render them brighter. */
  stackLines(stack: string): { t: string; app: boolean }[] {
    return (stack || '').split('\n').map(ln => ({
      t: ln || ' ',
      app: (/\.tsx|\.ts:/.test(ln) || (/\.go:/.test(ln) && !/\/usr\/local\/go|go\/src|pkg\/mod/.test(ln))),
    }));
  }

  /** Pretty-print + syntax-highlight a JSON context blob. Input is escaped before
   *  any markup is added, so the bypassed HTML is safe. */
  contextHtml(ctx?: string): SafeHtml {
    let raw: string;
    try { raw = JSON.stringify(JSON.parse(ctx || ''), null, 2); } catch { raw = ctx || ''; }
    const html = raw
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/("(?:\\.|[^"\\])*")(\s*:)/g, '<span class="j-key">$1</span>$2')
      .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span class="j-str">$1</span>')
      .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="j-num">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span class="j-lit">$1</span>');
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  trackFp = (_: number, g: DiagGroup) => g.fingerprint;
  trackId = (_: number, e: DiagEvent) => e.id;
}

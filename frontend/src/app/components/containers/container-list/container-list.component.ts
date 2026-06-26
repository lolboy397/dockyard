import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { DockerService } from '../../../services/docker.service';
import { WebSocketService, ContainerStatSummary } from '../../../services/websocket.service';
import { RealtimeService } from '../../../services/realtime.service';
import { NotificationService } from '../../../services/notification.service';
import { ConfirmDialogService } from '../../../services/confirm-dialog.service';
import { ContainerStateService } from '../../../services/container-state.service';
import { AuthService } from '../../../auth/auth.service';
import { ContainerSummary, ContainerInspect, ContainerStats, WatchedImage } from '../../../models/docker.models';
import { ContextMenuService, ContextMenuItem } from '../../../services/context-menu.service';
import { PruneDialogService } from '../../../services/prune-dialog.service';
import { optimisticPatch } from '../../../helpers/optimistic.helper';
import { IconComponent } from '../../shared/icon/icon.component';
import { ModalComponent } from '../../shared/modal/modal.component';
import { StatusDotComponent, statusTone } from '../../shared/status-dot/status-dot.component';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { LongPressDirective } from '../../../directives/long-press.directive';
import { PullToRefreshDirective } from '../../../directives/pull-to-refresh.directive';

@Component({
  selector: 'app-container-list',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, StatusDotComponent, ModalComponent, ScrollingModule, LongPressDirective, PullToRefreshDirective],
  templateUrl: './container-list.component.html',
})
export class ContainerListComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('shellOutput') shellOutputEl?: ElementRef<HTMLDivElement>;
  @ViewChild('shellInput') shellInputEl?: ElementRef<HTMLInputElement>;

  // List state
  containers: ContainerSummary[] = [];
  filtered: ContainerSummary[] = [];
  loading = false;
  containerFilter: 'all' | 'running' | 'stopped' = 'all';
  searchQuery = '';
  readonly skeletonRows = [1, 2, 3, 4, 5, 6];
  private pollSub?: Subscription;

  // Phone/tablet: render lightweight cards instead of the virtual-scroll table
  // (the fixed itemSize=42 can't represent a multi-line card).
  isMobile = false;
  private mqlMobile = matchMedia('(max-width: 820px)');
  private mqlListener = (e: MediaQueryListEvent): void => { this.isMobile = e.matches; };

  // All-container stats (for table columns)
  private allStatsSub?: Subscription;
  private allStatsMap: Map<string, ContainerStatSummary> = new Map();

  // Detail state
  selectedContainer: ContainerSummary | null = null;
  inspect: ContainerInspect | null = null;
  loadingDetail = false;
  detailTab: 'overview' | 'logs' | 'shell' | 'ports' | 'env' | 'mounts' | 'stats' | 'updates' = 'overview';
  logFilter = '';
  logLevelFilter: 'all' | 'info' | 'warn' | 'err' = 'all';
  stats: ContainerStats | null = null;
  logLines: string[] = [];
  liveLog = false;
  private logSub?: Subscription;
  private statsSub?: Subscription;

  // Sparkline history (detail panel)
  cpuHistory:    number[] = [];
  memHistory:    number[] = [];
  netRxHistory:  number[] = [];
  netTxHistory:  number[] = [];
  netRxRate = '—';
  netTxRate = '—';
  private prevNetRx  = 0;
  private prevNetTx  = 0;
  private prevStatsTime = 0;

  // Image-updates ("updates") tab state. watch === null means this container is
  // not being watched. INTERVALS are the selectable check cadences (seconds).
  watch: WatchedImage | null = null;
  watchLoading = false;
  watchBusy = false;       // creating/removing/saving config
  watchChecking = false;   // a manual "Check now" in flight
  watchUpdating = false;   // a manual "Update now" in flight
  readonly watchIntervals: { label: string; value: number }[] = [
    { label: '15m', value: 900 },
    { label: '1h',  value: 3600 },
    { label: '6h',  value: 21600 },
    { label: '24h', value: 86400 },
  ];

  // Shell tab state
  shellLines: string[] = [];
  shellCmd = '';
  shellConnected = false;
  shellHistory: string[] = [];
  shellHistoryIdx = -1;
  private shellSession?: { output$: import('rxjs').Observable<string>; send: (cmd: string) => void; close: () => void };
  private shellOutputSub?: Subscription;
  private shouldScrollShell = false;

  get runningCount(): number { return this.containers.filter(c => c.State === 'running').length; }
  get stoppedCount(): number { return this.containers.filter(c => c.State !== 'running').length; }

  objectKeys = Object.keys;

  get filteredLogs(): string[] {
    let lines = this.logLines;
    if (this.logFilter) {
      const f = this.logFilter.toLowerCase();
      lines = lines.filter(l => l.toLowerCase().includes(f));
    }
    if (this.logLevelFilter !== 'all') {
      lines = lines.filter(l => this.levelOf(l) === this.logLevelFilter);
    }
    return lines;
  }

  levelOf(line: string): 'info' | 'warn' | 'err' | 'dbg' {
    const u = line.toUpperCase();
    if (/\b(ERR(?:OR)?|FATAL|CRIT(?:ICAL)?)\b/.test(u)) return 'err';
    if (/\bWARN(?:ING)?\b/.test(u)) return 'warn';
    if (/\b(DEBUG|TRACE)\b/.test(u)) return 'dbg';
    return 'info'; // everything else is INFO by default
  }

  parseLine(line: string): { ts: string; lvl: string; lvlClass: string; msg: string } {
    let rest = line;

    // Try to extract timestamp from the start of the line
    const tsPatterns = [
      /^(\d{4}[-\/]\d{2}[-\/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*/,
      /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*/,
      /^\[(\d{4}[-\/]\d{2}[-\/]\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*)\]\s*/,
    ];
    let ts = '';
    for (const p of tsPatterns) {
      const m = rest.match(p);
      if (m) {
        // Extract just HH:MM:SS — drop the date prefix to save space
        const timeOnly = m[1].match(/(\d{2}:\d{2}:\d{2})/);
        ts = timeOnly ? timeOnly[1] : m[1].slice(0, 19);
        rest = rest.slice(m[0].length);
        break;
      }
    }

    // Try to extract an explicit level keyword right after the timestamp
    const explicitMatch = rest.match(/^\[?(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE|ERR)\]?[\s:]+/i);
    let lvl = 'INFO', lvlClass = 'lvl-info';
    if (explicitMatch) {
      rest = rest.slice(explicitMatch[0].length);
      const key = explicitMatch[1].toUpperCase();
      if (/^(ERR|ERROR|FATAL|CRITICAL)$/.test(key)) { lvl = 'ERR';  lvlClass = 'lvl-err';  }
      else if (/^(WARN|WARNING)$/.test(key))          { lvl = 'WARN'; lvlClass = 'lvl-warn'; }
      else if (/^(DEBUG|TRACE)$/.test(key))            { lvl = 'DBG';  lvlClass = 'lvl-dbg';  }
    } else {
      // Fall back to detecting elevated keywords anywhere in the original line
      const u = line.toUpperCase();
      if (/\b(ERROR|FATAL|CRITICAL|ERR)\b/.test(u)) { lvl = 'ERR';  lvlClass = 'lvl-err';  }
      else if (/\bWARN(?:ING)?\b/.test(u))           { lvl = 'WARN'; lvlClass = 'lvl-warn'; }
    }

    return { ts, lvl, lvlClass, msg: rest || line };
  }

  /** Returns CPU% string for a container from the allstats map. */
  containerCpu(id: string): string {
    const s = this.allStatsMap.get(id);
    return s ? `${s.cpu.toFixed(1)}%` : '—';
  }

  /** Returns memory usage string for a container from the allstats map. */
  containerMem(id: string): string {
    const s = this.allStatsMap.get(id);
    return s ? this.formatBytes(s.mem) : '—';
  }

  get cpuPercent(): string {
    if (!this.stats) return '—';
    const cpu = this.stats.cpu_stats.cpu_usage.total_usage - this.stats.precpu_stats.cpu_usage.total_usage;
    const sys = this.stats.cpu_stats.system_cpu_usage - this.stats.precpu_stats.system_cpu_usage;
    const n = this.stats.cpu_stats.online_cpus || 1;
    return sys > 0 ? ((cpu / sys) * n * 100).toFixed(1) : '0.0';
  }
  get memUsage(): string { return this.stats ? this.formatBytes(this.stats.memory_stats?.usage) : '—'; }

  constructor(
    private docker: DockerService,
    private ws: WebSocketService,
    private notify: NotificationService,
    private containerState: ContainerStateService,
    private confirm: ConfirmDialogService,
    private ctxMenu: ContextMenuService,
    public auth: AuthService,
    private realtime: RealtimeService,
    private pruneDialog: PruneDialogService,
  ) {}

  // Resource-limits modal
  limitsContainer: ContainerSummary | null = null;
  limitsName = '';
  limitsForm = { cpus: 0, memory_mb: 0, restart_policy: 'unless-stopped' };
  savingLimits = false;

  openLimits(c: ContainerSummary): void {
    this.limitsContainer = c;
    this.limitsName = c.Names && c.Names[0] ? c.Names[0].replace('/', '') : c.Id.slice(0, 12);
    this.limitsForm = { cpus: 0, memory_mb: 0, restart_policy: 'unless-stopped' };
  }

  saveLimits(): void {
    const c = this.limitsContainer;
    if (!c) return;
    this.savingLimits = true;
    this.docker.updateContainerResources(c.Id, { ...this.limitsForm }).subscribe({
      next: () => { this.notify.success('Resource limits applied'); this.savingLimits = false; this.limitsContainer = null; this.load(true); },
      error: e => { this.notify.error(e?.error?.error || 'Failed to apply limits'); this.savingLimits = false; },
    });
  }

  ngOnInit(): void {
    this.isMobile = this.mqlMobile.matches;
    this.mqlMobile.addEventListener('change', this.mqlListener);
    const cached = this.containerState.snapshot;
    if (this.containerState.hasCache) {
      // Restore previous state instantly — no spinner
      this.containers = cached.containers;
      this.containerFilter = cached.containerFilter ?? 'all';
      this.searchQuery = cached.searchQuery;
      this.filterContainers();
      if (cached.selectedId) {
        const sel = this.containers.find(c => c.Id === cached.selectedId);
        if (sel) {
          this.selectedContainer = sel;
          this.detailTab = cached.detailTab as typeof this.detailTab;
          this.inspect = cached.inspect;
          this.loadWatch(sel.Id);
          if (sel.State === 'running') this.startStats();
        }
      }
      // Silent background refresh
      this.load(false);
    } else {
      this.load(true);
    }
    // Refetch the list on container lifecycle events (+ resync on reconnect /
    // refocus) instead of a blind 15s poll. Live CPU/mem still comes from allStats.
    this.pollSub = this.realtime.changes(['container']).subscribe(() => this.load(false));
    this.allStatsSub = this.ws.streamAllStats().subscribe(list => {
      list.forEach(s => this.allStatsMap.set(s.id, s));
    });
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollShell && this.shellOutputEl) {
      const el = this.shellOutputEl.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScrollShell = false;
    }
  }

  ngOnDestroy(): void {
    // Persist state so it can be restored on next visit
    this.containerState.patch({
      selectedId: this.selectedContainer?.Id ?? null,
      detailTab: this.detailTab,
      inspect: this.inspect,
    });
    this.pollSub?.unsubscribe();
    this.allStatsSub?.unsubscribe();
    this.mqlMobile.removeEventListener('change', this.mqlListener);
    this.stopStreams();
    this.disconnectShell();
  }

  statusTone = statusTone;

  load(showSpinner = false): void {
    // Only show the skeleton on the very first load (no cache yet)
    if (showSpinner && !this.containerState.hasCache) this.loading = true;
    // Always fetch all containers; running-only filter is applied client-side
    this.docker.listContainers(true).subscribe({
      next: c => {
        this.containers = c;
        this.containerState.patch({ containers: c });
        this.filterContainers();
        this.loading = false;
        if (this.selectedContainer) {
          const updated = c.find(x => x.Id === this.selectedContainer!.Id);
          if (updated) this.selectedContainer = updated;
          else this.closeDetail();
        }
      },
      error: () => { this.notify.error('Failed to load containers'); this.loading = false; },
    });
  }

  filterContainers(): void {
    const q = this.searchQuery.toLowerCase();
    let base: ContainerSummary[];
    if (this.containerFilter === 'running') base = this.containers.filter(c => c.State === 'running');
    else if (this.containerFilter === 'stopped') base = this.containers.filter(c => c.State !== 'running');
    else base = [...this.containers];
    this.filtered = q
      ? base.filter(c =>
          c.Names.some(n => n.toLowerCase().includes(q)) ||
          c.Image.toLowerCase().includes(q) ||
          c.Id.toLowerCase().includes(q))
      : [...base];
    this.containerState.patch({ containerFilter: this.containerFilter, searchQuery: this.searchQuery });
  }

  // Stable identity for *cdkVirtualFor so only changed rows re-render.
  trackById = (_: number, c: ContainerSummary): string => c.Id;

  select(c: ContainerSummary): void {
    if (this.selectedContainer?.Id === c.Id) { this.closeDetail(); return; }
    this.selectedContainer = c;
    this.containerState.patch({ selectedId: c.Id });
    this.detailTab = 'overview';
    this.inspect = null;
    this.stats = null;
    this.logLines = [];
    this.logFilter = '';
    this.logLevelFilter = 'all';
    this.watch = null;
    this.stopStreams();
    this.loadingDetail = true;
    this.docker.inspectContainer(c.Id).subscribe({
      next: i => { this.inspect = i; this.loadingDetail = false; },
      error: () => { this.notify.error('Failed to load container details'); this.loadingDetail = false; },
    });
    this.loadWatch(c.Id);
    if (c.State === 'running') this.startStats();
  }

  closeDetail(): void {
    this.containerState.patch({ selectedId: null, inspect: null });
    this.selectedContainer = null;
    this.inspect = null;
    this.stats = null;
    this.watch = null;
    this.logLines = [];
    this.liveLog = false;
    this.logFilter = '';
    this.logLevelFilter = 'all';
    this.cpuHistory = []; this.memHistory = [];
    this.netRxHistory = []; this.netTxHistory = [];
    this.netRxRate = '—'; this.netTxRate = '—';
    this.prevNetRx = 0; this.prevNetTx = 0; this.prevStatsTime = 0;
    this.stopStreams();
    this.disconnectShell();
  }

  detailAction(act: string): void {
    if (!this.selectedContainer) return;
    const id = this.selectedContainer.Id;
    const name = this.selectedContainer.Names[0]?.replace('/', '');
    let action$;
    if (act === 'start') action$ = this.docker.startContainer(id);
    else if (act === 'stop') action$ = this.docker.stopContainer(id);
    else if (act === 'restart') action$ = this.docker.restartContainer(id);
    else return;
    action$.subscribe({
      next: () => { this.notify.success(`${act} — ${name}`); this.load(false); },
      error: () => this.notify.error(`Failed to ${act} ${name}`),
    });
  }

  switchToLogs(): void {
    this.detailTab = 'logs';
    if (!this.liveLog && this.selectedContainer) this.startLogs();
  }

  switchToStats(): void {
    this.detailTab = 'stats';
    if (!this.stats && this.selectedContainer) this.startStats();
  }

  // ── Image updates (per-container watch) ──────────────────────────────────────

  loadWatch(containerId: string): void {
    this.watchLoading = true;
    this.docker.getWatchedImages().subscribe({
      next: list => {
        if (this.selectedContainer?.Id !== containerId) return; // selection moved on
        this.watch = list.find(w => w.container_id === containerId) ?? null;
        this.watchLoading = false;
      },
      error: () => { this.watchLoading = false; },
    });
  }

  get watchUpdateAvailable(): boolean { return !!this.watch?.update_available; }

  watchStatus(): { label: string; tone: 'running' | 'warn' | 'idle' } {
    if (!this.watch) return { label: 'Not watched', tone: 'idle' };
    if (this.watch.update_available) return { label: 'Update available', tone: 'warn' };
    if (this.watch.last_checked_at) return { label: 'Up to date', tone: 'running' };
    return { label: 'Not checked yet', tone: 'idle' };
  }

  // Master toggle: start or stop watching this container's image for updates.
  toggleWatch(): void {
    const c = this.selectedContainer;
    if (!c || this.watchBusy) return;
    const name = c.Names[0]?.replace('/', '') ?? '';
    if (this.watch) {
      this.watchBusy = true;
      this.docker.deleteWatchedImage(c.Id).subscribe({
        next: () => { this.watch = null; this.watchBusy = false; this.notify.success('Stopped watching for updates'); },
        error: () => { this.watchBusy = false; this.notify.error('Failed to stop watching'); },
      });
    } else {
      this.watchBusy = true;
      const payload: WatchedImage = {
        container_id: c.Id, container_name: name, image: c.Image,
        current_digest: '', check_interval: 3600, auto_update: false, enabled: true,
      };
      this.docker.upsertWatchedImage(payload).subscribe({
        next: () => {
          this.watch = payload;          // reflect "On" immediately
          this.watchBusy = false;
          this.notify.success('Watching for image updates');
          this.watchCheckNow();          // then refresh with the real digest/state
        },
        error: () => { this.watchBusy = false; this.notify.error('Failed to start watching'); },
      });
    }
  }

  toggleAutoUpdate(): void {
    if (!this.watch || this.watchBusy) return;
    const next = !this.watch.auto_update;
    optimisticPatch(this.watch, { auto_update: next },
      this.docker.upsertWatchedImage({ ...this.watch, auto_update: next }),
      { busy: { host: this, key: 'watchBusy' }, onError: () => this.notify.error('Failed to update setting') });
  }

  changeWatchInterval(seconds: number): void {
    if (!this.watch || this.watchBusy) return;
    const secs = +seconds;
    optimisticPatch(this.watch, { check_interval: secs },
      this.docker.upsertWatchedImage({ ...this.watch, check_interval: secs }),
      { busy: { host: this, key: 'watchBusy' }, onError: () => this.notify.error('Failed to update interval') });
  }

  watchCheckNow(): void {
    const c = this.selectedContainer;
    if (!c || this.watchChecking) return;
    this.watchChecking = true;
    this.docker.checkWatchedImage(c.Id).subscribe({
      next: w => { if (this.selectedContainer?.Id === c.Id) this.watch = w; this.watchChecking = false; },
      error: () => { this.watchChecking = false; this.notify.error('Check failed'); },
    });
  }

  watchUpdateNow(): void {
    const c = this.selectedContainer;
    if (!c || this.watchUpdating) return;
    const name = c.Names[0]?.replace('/', '') ?? '';
    this.watchUpdating = true;
    this.docker.updateWatchedImage(c.Id).subscribe({
      next: () => {
        this.notify.success(`Updated ${name}`);
        this.watchUpdating = false;
        // The container is recreated with a new ID — reload and reselect by name.
        this.docker.listContainers(true).subscribe(list => {
          this.containers = list;
          this.containerState.patch({ containers: list });
          this.filterContainers();
          const recreated = list.find(x => x.Names.some(n => n.replace('/', '') === name));
          if (recreated) this.select(recreated);
          else this.closeDetail();
        });
      },
      error: e => { this.watchUpdating = false; this.notify.error(e?.error?.error || 'Update failed'); },
    });
  }


  startLogs(): void {
    if (!this.selectedContainer) return;
    this.logLines = [];
    this.liveLog = true;
    this.logSub = this.ws.streamLogs(this.selectedContainer.Id, '100').subscribe(line => {
      this.logLines.push(line);
      if (this.logLines.length > 500) this.logLines.shift();
    });
  }

  toggleLogs(): void {
    if (this.liveLog) { this.logSub?.unsubscribe(); this.liveLog = false; }
    else this.startLogs();
  }

  startStats(): void {
    if (!this.selectedContainer) return;
    this.statsSub?.unsubscribe();
    this.cpuHistory = []; this.memHistory = [];
    this.netRxHistory = []; this.netTxHistory = [];
    this.prevNetRx = 0; this.prevNetTx = 0; this.prevStatsTime = 0;
    this.statsSub = this.ws.streamStats(this.selectedContainer.Id).subscribe(s => {
      try {
        const parsed: ContainerStats = JSON.parse(s);
        this.stats = parsed;

        // CPU history
        const cpu = parsed.cpu_stats.cpu_usage.total_usage - parsed.precpu_stats.cpu_usage.total_usage;
        const sys = parsed.cpu_stats.system_cpu_usage - parsed.precpu_stats.system_cpu_usage;
        const n = parsed.cpu_stats.online_cpus || 1;
        const cpuVal = sys > 0 ? (cpu / sys) * n * 100 : 0;
        this.cpuHistory.push(cpuVal);
        if (this.cpuHistory.length > 20) this.cpuHistory.shift();

        // Memory history
        const memVal = parsed.memory_stats?.usage ?? 0;
        this.memHistory.push(memVal);
        if (this.memHistory.length > 20) this.memHistory.shift();

        // Network rate history
        const now = Date.now();
        const totalRx = parsed.networks ? Object.values(parsed.networks).reduce((a, net) => a + net.rx_bytes, 0) : 0;
        const totalTx = parsed.networks ? Object.values(parsed.networks).reduce((a, net) => a + net.tx_bytes, 0) : 0;
        if (this.prevStatsTime > 0) {
          const dt = (now - this.prevStatsTime) / 1000;
          const rxRate = Math.max(0, totalRx - this.prevNetRx) / dt;
          const txRate = Math.max(0, totalTx - this.prevNetTx) / dt;
          this.netRxHistory.push(rxRate);
          this.netTxHistory.push(txRate);
          if (this.netRxHistory.length > 20) this.netRxHistory.shift();
          if (this.netTxHistory.length > 20) this.netTxHistory.shift();
          this.netRxRate = this.formatBytes(rxRate) + '/s';
          this.netTxRate = this.formatBytes(txRate) + '/s';
        }
        this.prevNetRx = totalRx;
        this.prevNetTx = totalTx;
        this.prevStatsTime = now;
      } catch { /* ignore */ }
    });
  }

  stopStreams(): void {
    this.logSub?.unsubscribe();
    this.statsSub?.unsubscribe();
    this.liveLog = false;
  }

  action(c: ContainerSummary, act: string): void {
    const name = c.Names[0]?.replace('/', '');
    let action$;
    if (act === 'start') action$ = this.docker.startContainer(c.Id);
    else if (act === 'stop') action$ = this.docker.stopContainer(c.Id);
    else if (act === 'restart') action$ = this.docker.restartContainer(c.Id);
    else return;
    action$.subscribe({
      next: () => { this.notify.success(`${act} — ${name}`); this.load(false); },
      error: () => this.notify.error(`Failed to ${act} ${name}`),
    });
  }

  async remove(c: ContainerSummary): Promise<void> {
    const name = c.Names[0]?.replace('/', '');
    const ok = await this.confirm.confirm({
      title: `Remove container "${name}"?`,
      message: 'The container will be permanently deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.docker.removeContainer(c.Id, c.State !== 'running').subscribe({
      next: () => { this.notify.success(`Removed — ${name}`); this.load(false); },
      error: () => this.notify.error(`Failed to remove ${name}`),
    });
  }

  // ── Pause / resume ───────────────────────────────────────────────────────────

  pause(c: ContainerSummary): void {
    const name = c.Names[0]?.replace('/', '');
    this.docker.pauseContainer(c.Id).subscribe({
      next: () => { this.notify.success(`Paused — ${name}`); this.load(false); },
      error: () => this.notify.error(`Failed to pause ${name}`),
    });
  }

  resume(c: ContainerSummary): void {
    const name = c.Names[0]?.replace('/', '');
    this.docker.unpauseContainer(c.Id).subscribe({
      next: () => { this.notify.success(`Resumed — ${name}`); this.load(false); },
      error: () => this.notify.error(`Failed to resume ${name}`),
    });
  }

  // ── Context menu ───────────────────────────────────────────────────────────────

  private copyToClipboard(text: string, label: string): void {
    try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
    this.notify.info(`Copied ${label}`);
  }

  /** Ensure a row's detail panel is open without toggling it shut on re-entry. */
  private ensureSelected(c: ContainerSummary): void {
    if (this.selectedContainer?.Id !== c.Id) this.select(c);
  }

  private openShell(c: ContainerSummary): void {
    this.ensureSelected(c);
    this.detailTab = 'shell';
    if (!this.shellConnected) this.connectShell();
  }

  private viewLogs(c: ContainerSummary): void {
    this.ensureSelected(c);
    this.switchToLogs();
  }

  private inspectRow(c: ContainerSummary): void {
    this.ensureSelected(c);
    this.detailTab = 'overview';
  }

  /**
   * Status-aware container menu — a 1:1 port of `containerMenu()` in the
   * design-system ContainerTable.jsx, wired to real operations. Write actions
   * are gated by RBAC; read actions (logs/inspect/copy) are always available.
   */
  private buildContainerMenu(c: ContainerSummary): ContextMenuItem[] {
    const running = c.State === 'running';
    const paused = c.State === 'paused';
    const w = this.auth.canWrite();
    const name = c.Names[0]?.replace('/', '') ?? c.Id.slice(0, 12);
    const items: ContextMenuItem[] = [];

    if (w) {
      if (!running && !paused) {
        items.push({ label: 'Start', icon: 'play', shortcut: '⌘↵', accent: true, onSelect: () => this.action(c, 'start') });
      } else if (paused) {
        items.push({ label: 'Resume', icon: 'play', accent: true, onSelect: () => this.resume(c) });
      } else {
        items.push({ label: 'Turn off', icon: 'square', onSelect: () => this.action(c, 'stop') });
        items.push({ label: 'Pause', icon: 'pause', onSelect: () => this.pause(c) });
      }
      items.push({ label: 'Restart', icon: 'rotate-ccw', shortcut: '⌘R', disabled: !running, onSelect: () => this.action(c, 'restart') });
      items.push({ type: 'separator' });
    }

    items.push({ label: 'Open shell', icon: 'square-terminal', shortcut: '⌘T', disabled: !running || !w, onSelect: () => this.openShell(c) });
    items.push({ label: 'View logs', icon: 'scroll-text', onSelect: () => this.viewLogs(c) });
    items.push({ label: 'Inspect', icon: 'file-search', onSelect: () => this.inspectRow(c) });
    if (w) {
      items.push({ label: 'Resource limits…', icon: 'sliders-horizontal', onSelect: () => this.openLimits(c) });
    }

    items.push({ type: 'separator' });
    items.push({
      label: 'Copy', icon: 'copy', items: [
        { label: 'Container ID', icon: 'hash', onSelect: () => this.copyToClipboard(c.Id, 'container ID') },
        { label: 'Name', icon: 'tag', onSelect: () => this.copyToClipboard(name, 'name') },
        { label: 'Image', icon: 'layers', onSelect: () => this.copyToClipboard(c.Image, 'image') },
      ],
    });

    if (w) {
      items.push({ type: 'separator' });
      items.push({ label: 'Force remove', icon: 'trash-2', shortcut: '⌫', danger: true, onSelect: () => this.remove(c) });
    }
    return items;
  }

  rowMenu(e: MouseEvent, c: ContainerSummary): void {
    this.ensureSelected(c);
    this.ctxMenu.open(e, this.buildContainerMenu(c), {
      header: { name: c.Names[0]?.replace('/', '') ?? c.Id.slice(0, 12), meta: c.Image, icon: 'box' },
    });
  }

  ellipsisMenu(e: MouseEvent, c: ContainerSummary): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.ensureSelected(c);
    this.ctxMenu.open(e, this.buildContainerMenu(c), {
      header: { name: c.Names[0]?.replace('/', '') ?? c.Id.slice(0, 12), meta: c.Image, icon: 'box' },
      x: r.right, y: r.bottom + 4,
    });
  }

  async pruneContainers(): Promise<void> {
    // Match what the backend actually prunes (created/exited/dead) — not every
    // non-running state (which would over-count restarting/removing).
    const stopped = this.containers.filter(c => ['created', 'exited', 'dead'].includes(c.State));
    const changed = await this.pruneDialog.open({
      kind: 'containers',
      title: 'Prune stopped containers',
      noun: 'container',
      scopes: [
        { all: false, label: 'Stopped', count: stopped.length, bytes: 0, note: 'All created, exited and dead containers' },
      ],
      run: () => this.docker.pruneContainers(),
    });
    if (changed) this.load(false);
  }

  formatPorts(ports: any[]): string {
    if (!ports || ports.length === 0) return '—';
    const mapped = ports
      .filter((p: any) => p.PublicPort)
      .map((p: any) => `:${p.PublicPort}→${p.PrivatePort}`);
    if (!mapped.length) return '—';
    if (mapped.length > 2) return mapped.slice(0, 2).join(' ') + ` +${mapped.length - 2}`;
    return mapped.join(' ');
  }

  timeAgo(unixSecs: number): string {
    const diff = Math.floor(Date.now() / 1000) - unixSecs;
    if (diff < 60)    return `${diff}s ago`;
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // ---- Shell -----------------------------------------------------------------

  connectShell(): void {
    if (!this.selectedContainer || this.shellConnected) return;
    this.shellLines = [];
    const session = this.ws.streamExec(this.selectedContainer.Id);
    this.shellSession = session;
    this.shellConnected = true;
    this.shellOutputSub = session.output$.subscribe({
      next: (raw: string) => {
        // Strip ANSI escape codes for plain display
        const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        clean.split('\n').forEach(line => {
          if (line) this.shellLines.push(line);
        });
        if (this.shellLines.length > 1000) this.shellLines = this.shellLines.slice(-1000);
        this.shouldScrollShell = true;
      },
      complete: () => { this.shellConnected = false; this.shellLines.push('[session closed]'); },
      error: () => { this.shellConnected = false; this.shellLines.push('[connection error]'); },
    });
  }

  disconnectShell(): void {
    this.shellSession?.close();
    this.shellOutputSub?.unsubscribe();
    this.shellConnected = false;
    this.shellSession = undefined;
  }

  sendShellCmd(): void {
    if (!this.shellCmd.trim() || !this.shellSession) return;
    this.shellLines.push(`$ ${this.shellCmd}`);
    this.shellHistory.unshift(this.shellCmd);
    this.shellHistoryIdx = -1;
    this.shellSession.send(this.shellCmd);
    this.shellCmd = '';
    this.shouldScrollShell = true;
  }

  shellHistoryUp(): void {
    if (this.shellHistory.length === 0) return;
    this.shellHistoryIdx = Math.min(this.shellHistoryIdx + 1, this.shellHistory.length - 1);
    this.shellCmd = this.shellHistory[this.shellHistoryIdx];
  }

  shellHistoryDown(): void {
    this.shellHistoryIdx = Math.max(this.shellHistoryIdx - 1, -1);
    this.shellCmd = this.shellHistoryIdx >= 0 ? this.shellHistory[this.shellHistoryIdx] : '';
  }

  portEntries(ports: Record<string, any>): { host: string; container: string; protocol: string }[] {
    return Object.entries(ports || {}).flatMap(([k, bindings]) => {
      const [containerPort, proto] = k.split('/');
      return (bindings || []).map((b: any) => ({
        host: `${b.HostIp || '0.0.0.0'}:${b.HostPort}`,
        container: containerPort,
        protocol: proto?.toUpperCase() ?? 'TCP',
      }));
    });
  }

  copyEnvAsFile(): void {
    if (!this.inspect?.Config?.Env) return;
    const text = this.inspect.Config.Env.join('\n');
    navigator.clipboard.writeText(text);
  }

  badgeBg(tone: string): string {
    const m: Record<string, string> = {
      running: 'rgba(16,185,129,0.12)',
      warn:    'rgba(245,158,11,0.12)',
      danger:  'rgba(239,68,68,0.12)',
      info:    'rgba(59,130,246,0.12)',
      idle:    'rgba(148,163,184,0.10)',
    };
    return m[tone] ?? m['idle'];
  }

  badgeFg(tone: string): string {
    const m: Record<string, string> = {
      running: '#34D399',
      warn:    '#FBBF24',
      danger:  '#F87171',
      info:    '#60A5FA',
      idle:    '#94A3B8',
    };
    return m[tone] ?? m['idle'];
  }

  formatBytes(bytes?: number): string {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  sparkPoints(data: number[]): string {
    if (data.length < 2) return '';
    const max = Math.max(...data, 1);
    return data.map((v, i) =>
      `${(i * 70) / (data.length - 1)},${28 - (v / max) * 24}`
    ).join(' ');
  }

  networkSummary(insp: ContainerInspect): string {
    if (!insp.NetworkSettings?.Networks) return '—';
    const entries = Object.entries(insp.NetworkSettings.Networks) as [string, any][];
    if (entries.length === 0) return '—';
    const [name, net] = entries[0];
    return net?.IPAddress ? `${name} · ${net.IPAddress}` : name;
  }
}

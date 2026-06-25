import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { forkJoin } from 'rxjs';
import { DockerService } from '../../services/docker.service';
import {
  SystemInfo, HostStats, DockerDiskSummary, AppEvent, Project, ProjectStatus,
} from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, IconComponent, StatusDotComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, OnDestroy {
  loading = true;
  info: SystemInfo | null = null;
  projects: Project[] = [];
  events: AppEvent[] = [];
  dockerDisk: DockerDiskSummary | null = null;
  hostStats: HostStats | null = null;

  now = new Date();
  private clockTimer?: ReturnType<typeof setInterval>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private dfTimer?: ReturnType<typeof setInterval>;

  // Live host-load history, accumulated from the real 5s host-stats poll.
  cpuHistory: number[] = [];
  memHistory: number[] = [];

  // Ring gauge constants
  readonly ringR = 37;
  readonly ringC = +(2 * Math.PI * 37).toFixed(3);

  constructor(private docker: DockerService) {}

  ngOnInit(): void {
    this.clockTimer = setInterval(() => { this.now = new Date(); }, 1000);
    this.load();
    this.loadMetricHistory();
    this.loadDockerDisk();
    this.statsTimer = setInterval(() => { this.loadHostStats(); }, 5000);
    // `docker system df` walks every image/container/volume, so refresh it on a
    // slower cadence than the 5s host-stats poll.
    this.dfTimer = setInterval(() => { this.loadDockerDisk(); }, 30000);
  }

  ngOnDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.dfTimer) clearInterval(this.dfTimer);
  }

  private loadDockerDisk(): void {
    this.docker.getDockerDisk().subscribe({
      next: d => { this.dockerDisk = d; },
      error: () => { /* gauge falls back to host-disk % if unavailable */ },
    });
  }

  load(): void {
    this.loading = true;
    forkJoin({
      info: this.docker.getSystemInfo(),
      projects: this.docker.listProjects(),
      events: this.docker.getEvents(),
    }).subscribe({
      next: ({ info, projects, events }) => {
        this.info = info;
        this.projects = projects ?? [];
        this.events = events ?? [];
        this.loading = false;
        this.loadHostStats();
      },
      error: () => { this.loading = false; },
    });
  }

  private loadHostStats(): void {
    this.docker.getHostStats().subscribe({
      next: stats => {
        this.hostStats = stats;
        // Append the live reading to the persisted history (last ~hour).
        this.cpuHistory = [...this.cpuHistory, this.cpuPct].slice(-240);
        this.memHistory = [...this.memHistory, this.memPct].slice(-240);
      },
      error: () => { /* rings stay at 0 if endpoint unavailable */ },
    });
  }

  // Seed the host-load chart from the persisted time-series so it shows real
  // history immediately instead of building up from empty.
  private loadMetricHistory(): void {
    this.docker.getMetricsHistory(3600).subscribe({
      next: samples => {
        if (samples?.length) {
          this.cpuHistory = samples.map(s => Math.round(s.cpu_pct));
          this.memHistory = samples.map(s => s.mem_total ? Math.round(s.mem_used / s.mem_total * 100) : 0);
        }
      },
      error: () => { /* no history yet */ },
    });
  }

  // Computed properties

  get time(): string {
    return this.now.toLocaleTimeString('en-GB', { hour12: false });
  }

  get date(): string {
    return this.now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  get headline(): string {
    const failed = this.projects.filter(p => p.status === 'failed').length;
    if (failed > 0) return 'Some builds require attention';
    return 'All systems operational';
  }

  get projectsRunning(): number {
    return this.projects.filter(p => p.status === 'running').length;
  }

  get projectsBuilding(): number {
    return this.projects.filter(p => p.status === 'building').length;
  }

  get projectsFailed(): number {
    return this.projects.filter(p => p.status === 'failed').length;
  }

  get dashProjects(): Project[] {
    return this.projects.slice(0, 6);
  }

  get deploysToday(): number {
    const today = new Date().toDateString();
    return this.events.filter(e =>
      new Date(e.created_at).toDateString() === today &&
      (e.kind.includes('success') || e.kind.includes('deploy') || e.kind.includes('build'))
    ).length;
  }

  get successRate(): number {
    const today = new Date().toDateString();
    const todayEvents = this.events.filter(e => new Date(e.created_at).toDateString() === today);
    if (todayEvents.length === 0) return 100;
    const failed = todayEvents.filter(e => e.kind.includes('fail')).length;
    return Math.round((todayEvents.length - failed) / todayEvents.length * 100);
  }

  // De-duplicated total image footprint (matches `docker system df`), from the
  // shared df summary — so the dashboard makes a single df walk, not two.
  get totalImageSize(): number {
    return this.dockerDisk?.images ?? 0;
  }

  get cpuPct(): number {
    return this.hostStats ? Math.round(this.hostStats.cpu_pct) : 0;
  }

  get memPct(): number {
    if (!this.hostStats?.mem_total) return 0;
    return Math.round(this.hostStats.mem_used / this.hostStats.mem_total * 100);
  }

  get memUsedGB(): string {
    if (!this.hostStats?.mem_used) return '—';
    const gb = this.hostStats.mem_used / (1024 ** 3);
    return gb >= 1 ? gb.toFixed(1) : `${(this.hostStats.mem_used / (1024 ** 2)).toFixed(0)}M`;
  }

  get diskPct(): number {
    if (!this.hostStats?.disk_total) return 0;
    return Math.round(this.hostStats.disk_used / this.hostStats.disk_total * 100);
  }

  // Docker's own disk footprint (`docker system df`). The storage gauge shows
  // this rather than the whole-host-disk percentage: it actually moves as you
  // build/pull/prune, and the reclaimable figure is directly actionable.

  // Ring fill: how much of the host disk Docker's data occupies. Falls back to
  // raw host-disk fullness if the df summary isn't available.
  get diskRingPct(): number {
    if (!this.dockerDisk) return this.diskPct;
    if (!this.hostStats?.disk_total) return 0;
    return Math.round(this.dockerDisk.total / this.hostStats.disk_total * 100);
  }

  // Ring center: Docker disk usage (e.g. "24.3G"), or host-disk % as a fallback.
  get diskRingValue(): string {
    return this.dockerDisk ? this.compactBytes(this.dockerDisk.total) : `${this.diskPct}%`;
  }

  // Sub-label under the rings: the actionable companion to the gauge.
  get diskFootLabel(): string {
    if (!this.dockerDisk) return `${this.formatGB(this.hostStats?.disk_total)} disk`;
    const r = this.dockerDisk.reclaimable;
    return r > 0 ? `${this.formatGB(r)} reclaimable` : 'fully in use';
  }

  private compactBytes(bytes: number): string {
    if (!bytes) return '0';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)}G`;
    const mb = bytes / (1024 ** 2);
    if (mb >= 1) return `${mb.toFixed(0)}M`;
    return `${(bytes / 1024).toFixed(0)}K`;
  }

  get activityEvents(): AppEvent[] {
    const skip = new Set(['connect', 'disconnect', 'mount', 'unmount', 'create']);
    return this.events.filter(e => {
      if (e.object_type === 'network' || e.object_type === 'volume') return false;
      if (e.object_type === 'container' && skip.has(e.kind)) return false;
      // Skip low-signal image churn (untagged/deleted images by digest)
      if (e.object_type === 'image' && (e.object_name || '').startsWith('sha256:')) return false;
      return true;
    }).slice(0, 10);
  }

  // Ring helpers

  ringOffset(pct: number): number {
    return this.ringC * (1 - Math.min(100, Math.max(0, pct)) / 100);
  }

  // Sparkline helpers

  sparkPoints(series: number[], h = 36, w = 240): string {
    if (!series?.length) return '';
    const max = Math.max(...series);
    const min = Math.min(...series);
    const range = max - min || 1;
    return series.map((v, i) => {
      const x = series.length > 1 ? (i * w) / (series.length - 1) : w / 2;
      const y = h - ((v - min) / range) * (h - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  sparkPoly(series: number[], h = 36, w = 240): string {
    if (!series?.length) return '';
    return `0,${h} ${this.sparkPoints(series, h, w)} ${w},${h}`;
  }

  // Fixed 0–100% scale chart, used for the live host CPU/memory history.
  pctPoints(series: number[], h = 120, w = 480): string {
    if (!series?.length) return '';
    return series.map((v, i) => {
      const x = series.length > 1 ? (i * w) / (series.length - 1) : w / 2;
      const y = h - (Math.min(100, Math.max(0, v)) / 100) * (h - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  pctPoly(series: number[], h = 120, w = 480): string {
    if (!series?.length) return '';
    return `0,${h} ${this.pctPoints(series, h, w)} ${w},${h}`;
  }

  // Project helpers

  projCardClass(status: ProjectStatus): string {
    const map: Partial<Record<ProjectStatus, string>> = {
      running:  'dash-proj-running',
      building: 'dash-proj-building',
      failed:   'dash-proj-failed',
    };
    return map[status] ?? '';
  }

  projTone(status: ProjectStatus): 'running' | 'warn' | 'danger' | 'idle' | 'info' | 'accent' {
    if (status === 'running')  return 'running';
    if (status === 'building') return 'warn';
    if (status === 'failed')   return 'danger';
    return 'idle';
  }

  projPort(project: Project): string {
    if (!project.ports) return '';
    const first = project.ports.split(',')[0]?.trim();
    return first?.split(':')[0] ?? '';
  }

  // Activity helpers

  actLabel(e: AppEvent): string {
    const raw = e.object_name || e.image || '';
    // Shorten sha256 digests to something readable
    const name = raw.startsWith('sha256:')
      ? (e.image || 'image:' + raw.slice(7, 15))
      : (raw.split('/').pop() || raw);
    switch (e.kind) {
      case 'start':   return `${name} started`;
      case 'stop':    return `${name} stopped`;
      case 'die':     return `${name} exited`;
      case 'kill':    return `${name} killed`;
      case 'destroy': return `${name} removed`;
      case 'rename':  return `${name} renamed`;
      case 'pause':   return `${name} paused`;
      case 'unpause': return `${name} resumed`;
      case 'restart': return `${name} restarted`;
      case 'pull':    return `pulled ${name}`;
      case 'push':    return `pushed ${name}`;
      case 'untag':
      case 'delete':  return `deleted ${name}`;
      case 'project_start':          return `${name} started`;
      case 'project_stop':           return `${name} stopped`;
      case 'project_build_success':  return `${name} built`;
      case 'project_build_failed':   return `${name} build failed`;
      case 'project_deploy':         return `${name} deployed`;
      case 'update_available':       return `update available · ${name}`;
      case 'auto_update':            return `${name} auto-updated`;
      default: return name ? `${name} · ${e.kind}` : e.kind;
    }
  }

  actIcon(kind: string): string {
    if (kind.includes('success') || kind.includes('start') || kind === 'deploy') return 'check';
    if (kind.includes('fail') || kind.includes('die'))   return 'circle-x';
    if (kind.includes('available') || kind.includes('update')) return 'arrow-down-circle';
    if (kind.includes('build'))  return 'hammer';
    if (kind.includes('stop'))   return 'square';
    return 'activity';
  }

  actTone(kind: string): string {
    if (kind.includes('success') || kind.includes('start') || kind === 'deploy') return 'running';
    if (kind.includes('fail') || kind.includes('die'))   return 'danger';
    if (kind.includes('available') || kind.includes('update')) return 'info';
    if (kind.includes('warn')) return 'warn';
    return 'idle';
  }

  formatActTime(ts: string): string {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  timeAgo(ts: string): string {
    if (!ts) return 'never';
    const d = new Date(ts);
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return 'never';
    const secs = Math.floor((Date.now() - d.getTime()) / 1000);
    if (secs < 5)     return 'just now';
    if (secs < 60)    return `${secs}s ago`;
    if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  formatGB(bytes?: number): string {
    if (!bytes) return '—';
    const gb = bytes / (1024 ** 3);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
  }
}

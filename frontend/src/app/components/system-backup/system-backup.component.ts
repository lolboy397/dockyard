import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DockerService, BackupsOverview, BkpPolicy, BkpHistory, BkpDest,
} from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ContextMenuService } from '../../services/context-menu.service';
import { AuthService } from '../../auth/auth.service';
import { IconComponent } from '../shared/icon/icon.component';
import { LongPressDirective } from '../../directives/long-press.directive';
import { ResponsiveService } from '../../services/responsive.service';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';
import { optimistic } from '../../helpers/optimistic.helper';

interface PolicyTarget { id: string; name: string; icon: string; meta: string; kind: 'volume' | 'app'; }

@Component({
  selector: 'app-system-backup',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LongPressDirective, StatusDotComponent],
  templateUrl: './system-backup.component.html',
  styleUrls: ['./system-backup.component.scss'],
})
export class SystemBackupComponent implements OnInit {
  loading = true;
  ov: BackupsOverview | null = null;
  filter: 'all' | 'completed' | 'running' | 'failed' = 'all';
  busy: string | null = null;

  // modals
  showNew = false;
  showSettings = false;
  restoreTarget: string | null = null;   // volume name when the restore modal is open

  // available targets for "New policy" (Application + volumes)
  targets: PolicyTarget[] = [];

  // cadences (interval_hours) we support
  readonly cadences = [
    { v: 6, label: 'Every 6h' },
    { v: 12, label: 'Every 12h' },
    { v: 24, label: 'Daily' },
    { v: 72, label: 'Every 3 days' },
    { v: 168, label: 'Weekly' },
  ];

  // New-policy form
  np = { step: 1, target: 'app', type: 'Consistent', cadence: 24, keep: 7, enabled: true };
  // Restore form
  rs = { point: '', where: 'original', newName: '' };
  // Settings form (the application-backup schedule + key info)
  sg = { enabled: false, interval: 24, keep: 7 };
  savingSettings = false;

  constructor(
    private docker: DockerService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
    public menu: ContextMenuService,
    public auth: AuthService,
    public responsive: ResponsiveService,
  ) {}

  ngOnInit(): void {
    if (!this.auth.isAdmin()) { this.loading = false; return; }
    this.load();
  }

  load(): void {
    this.loading = true;
    this.docker.getBackupsOverview().subscribe({
      next: o => { this.ov = o; this.loading = false; },
      error: () => { this.loading = false; this.notify.error('Could not load backups'); },
    });
  }

  // ── derived ────────────────────────────────────────────────────────────────
  get stats() { return this.ov?.stats; }
  get policies(): BkpPolicy[] { return this.ov?.policies || []; }
  get activeCount(): number { return this.policies.filter(p => p.enabled).length; }
  get recent(): BkpHistory[] { return this.ov?.recent || []; }

  get rows(): BkpHistory[] {
    const f = this.filter;
    return this.recent.filter(b =>
      f === 'all' ? true :
      f === 'completed' ? b.status === 'Completed' :
      f === 'failed' ? b.status === 'Failed' :
      f === 'running' ? b.status === 'Running' : true);
  }
  countStatus(s: string): number { return this.recent.filter(b => b.status === s).length; }

  get destSegments(): (BkpDest & { pct: number })[] {
    const dests = (this.ov?.destinations || []).filter(d => d.bytes > 0);
    const total = dests.reduce((a, d) => a + d.bytes, 0) || 1;
    return dests.map(d => ({ ...d, pct: Math.max(2, Math.round((d.bytes / total) * 100)) }));
  }
  get legendDests(): BkpDest[] { return this.ov?.destinations || []; }
  segColor(id: string): string { return id === 'host' ? '#22D3EE' : id === 'volume' ? '#34D399' : '#64748B'; }

  // ── actions ─────────────────────────────────────────────────────────────────
  togglePolicy(p: BkpPolicy): void {
    const enabled = !p.enabled;
    this.busy = p.id;
    const req$ = p.kind === 'app'
      ? this.docker.setAppBackupSchedule({ enabled, interval_hours: p.interval_hours, keep: p.keep })
      : this.docker.setBackupSchedule(p.target, { enabled, interval_hours: p.interval_hours, keep: p.keep, stop_container: p.stop_container });
    // Optimistic: flip the badge immediately; load() reconciles next-run times.
    optimistic({
      apply: () => { p.enabled = enabled; },
      rollback: () => { p.enabled = !enabled; },
      request$: req$,
      onSuccess: () => { this.notify[enabled ? 'success' : 'info'](enabled ? 'Policy enabled' : 'Policy paused'); this.busy = null; this.load(); },
      onError: (e) => { this.notify.error((e as any)?.error?.error || 'Could not update policy'); this.busy = null; },
    });
  }

  runPolicyNow(p: BkpPolicy): void {
    this.notify.info(`Backing up ${p.target}…`);
    const done = {
      next: () => { this.notify.success(`Backed up ${p.target}`); this.load(); },
      error: (e: any) => this.notify.error(e?.error?.error || 'Backup failed'),
    };
    if (p.kind === 'app') this.docker.createAppBackup().subscribe(done);
    else this.docker.createVolumeBackup(p.target, { stop_container: p.stop_container, note: 'manual' }).subscribe(done);
  }

  runAppBackup(): void {
    this.notify.info('Creating application backup…');
    this.docker.createAppBackup().subscribe({
      next: () => { this.notify.success('Application backup created'); this.load(); },
      error: (e) => this.notify.error(e?.error?.error || 'Backup failed'),
    });
  }

  download(b: BkpHistory): void {
    this.notify.info('Preparing download…');
    const obs = b.kind === 'app'
      ? this.docker.downloadAppBackup(b.name!)
      : this.docker.downloadVolumeBackup(b.volume_name!, b.backup_id!);
    obs.subscribe({
      next: resp => { if (resp.body) this.saveBlob(resp.body, b.kind === 'app' ? b.name! : `${b.target}-${b.backup_id}.tar.gz`); },
      error: () => this.notify.error('Could not download backup'),
    });
  }

  async deleteBackup(b: BkpHistory): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete backup?',
      message: `The backup of ${b.target} from ${this.relPast(b.started_at)} will be permanently removed.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    if (!this.ov) return;
    this.busy = b.id;
    const snapshot = this.ov.recent;
    const obs = b.kind === 'app'
      ? this.docker.deleteAppBackup(b.name!)
      : this.docker.deleteVolumeBackup(b.volume_name!, b.backup_id!);
    optimistic({
      apply: () => { this.ov!.recent = this.ov!.recent.filter(x => x.id !== b.id); },
      rollback: () => { this.ov!.recent = snapshot; },
      request$: obs,
      onSuccess: () => { this.notify.info('Backup deleted'); this.busy = null; this.load(); },
      onError: () => { this.notify.error('Delete failed'); this.busy = null; },
    });
  }

  async deletePolicy(p: BkpPolicy): Promise<void> {
    if (p.kind === 'app') { this.togglePolicy(p); return; } // app can't be deleted, only paused
    const ok = await this.confirm.confirm({
      title: 'Delete policy?',
      message: `The automatic-backup schedule for ${p.target} will be removed. Existing backups are kept.`,
      confirmLabel: 'Delete policy', danger: true,
    });
    if (!ok) return;
    if (!this.ov) return;
    const snapshot = this.ov.policies;
    optimistic({
      apply: () => { this.ov!.policies = this.ov!.policies.filter(x => x.id !== p.id); },
      rollback: () => { this.ov!.policies = snapshot; },
      request$: this.docker.deleteBackupSchedule(p.target),
      onSuccess: () => { this.notify.info('Policy deleted'); this.load(); },
      onError: () => this.notify.error('Could not delete policy'),
    });
  }

  copy(text: string, label: string): void {
    try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (e) {}
    this.notify.info(`Copied ${label}`);
  }

  // ── context menus (mirror the design) ────────────────────────────────────────
  policyMenu(e: MouseEvent, p: BkpPolicy): void {
    const items: any[] = [
      { label: 'Run now', icon: 'play', accent: true, onSelect: () => this.runPolicyNow(p) },
      { label: p.enabled ? 'Pause policy' : 'Enable policy', icon: p.enabled ? 'pause' : 'play', onSelect: () => this.togglePolicy(p) },
      { label: 'Edit schedule…', icon: 'pencil', onSelect: () => this.openEdit(p) },
    ];
    if (p.kind === 'volume') {
      items.push({ type: 'separator' });
      items.push({ label: 'Restore latest…', icon: 'rotate-ccw', onSelect: () => this.openRestore(p.target) });
      items.push({ type: 'separator' });
      items.push({ label: 'Delete policy', icon: 'trash-2', danger: true, onSelect: () => this.deletePolicy(p) });
    }
    this.menu.open(e, items, { header: { name: p.target, meta: p.cadence, icon: p.icon } });
  }

  rowMenu(e: MouseEvent, b: BkpHistory): void {
    const completed = b.status === 'Completed';
    const items: any[] = [];
    if (b.kind === 'volume') {
      items.push({ label: 'Restore…', icon: 'rotate-ccw', accent: true, disabled: !completed, onSelect: () => this.openRestore(b.volume_name!, b.backup_id) });
    }
    items.push({ label: 'Download', icon: 'download', disabled: !completed, onSelect: () => this.download(b) });
    items.push({ type: 'separator' });
    items.push({ label: 'Copy', icon: 'copy', items: [
      { label: 'Backup ID', icon: 'hash', onSelect: () => this.copy(b.id, 'backup ID') },
      { label: 'Destination', icon: 'hard-drive', onSelect: () => this.copy(b.dest, 'destination') },
    ] });
    items.push({ type: 'separator' });
    items.push({ label: 'Delete backup', icon: 'trash-2', danger: true, onSelect: () => this.deleteBackup(b) });
    this.menu.open(e, items, { header: { name: b.target, meta: b.id, icon: 'archive' } });
  }

  // ── New policy / edit ────────────────────────────────────────────────────────
  openNew(): void {
    this.np = { step: 1, target: 'app', type: 'Consistent', cadence: 24, keep: 7, enabled: true };
    this.loadTargets();
    this.showNew = true;
  }
  openEdit(p: BkpPolicy): void {
    this.np = {
      step: 1,
      target: p.kind === 'app' ? 'app' : p.target,
      type: p.stop_container ? 'Consistent' : 'Hot copy',
      cadence: p.interval_hours || 24, keep: p.keep || 7, enabled: p.enabled,
    };
    this.loadTargets();
    this.showNew = true;
  }
  private loadTargets(): void {
    const appTarget: PolicyTarget = { id: 'app', name: 'Application', icon: 'box', meta: 'database + secrets + stacks/repos/projects', kind: 'app' };
    this.targets = [appTarget];
    this.docker.listVolumes().subscribe({
      next: r => {
        const vols = (r.Volumes || []).map(v => ({ id: v.Name, name: v.Name, icon: 'database', meta: v.Driver || 'local', kind: 'volume' as const }));
        this.targets = [appTarget, ...vols];
      },
      error: () => {},
    });
  }
  get npTarget(): PolicyTarget | undefined { return this.targets.find(t => t.id === this.np.target); }
  get npIsApp(): boolean { return this.npTarget?.kind === 'app'; }
  get npDest(): string { return this.npIsApp ? 'Host directory' : 'Backup volume'; }
  get npCadenceLabel(): string { return this.cadences.find(c => c.v === this.np.cadence)?.label || 'Daily'; }

  createPolicy(): void {
    const t = this.npTarget;
    if (!t) return;
    const done = {
      next: () => { this.notify.success('Policy saved'); this.showNew = false; this.load(); },
      error: (e: any) => this.notify.error(e?.error?.error || 'Could not save policy'),
    };
    if (t.kind === 'app') {
      this.docker.setAppBackupSchedule({ enabled: this.np.enabled, interval_hours: this.np.cadence, keep: this.np.keep }).subscribe(done);
    } else {
      this.docker.setBackupSchedule(t.name, {
        enabled: this.np.enabled, interval_hours: this.np.cadence, keep: this.np.keep,
        stop_container: this.np.type === 'Consistent',
      }).subscribe(done);
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────────
  openRestore(volume: string, backupId?: number): void {
    const pts = this.restorePoints(volume);
    if (pts.length === 0) { this.notify.info(`No backups to restore for ${volume}`); return; }
    this.restoreTarget = volume;
    this.rs = { point: backupId ? `v${backupId}` : pts[0].id, where: 'original', newName: `${volume}-restored` };
  }
  // open restore from the header with no specific target → pick the latest volume backup's volume
  openRestoreLatest(): void {
    const latest = this.recent.find(b => b.kind === 'volume');
    if (!latest) { this.notify.info('No volume backups to restore'); return; }
    this.openRestore(latest.volume_name!, latest.backup_id);
  }
  restorePoints(volume: string): BkpHistory[] {
    return this.recent.filter(b => b.kind === 'volume' && b.volume_name === volume && b.status === 'Completed');
  }
  get rsPoint(): BkpHistory | undefined { return this.restorePoints(this.restoreTarget || '').find(p => p.id === this.rs.point); }

  async confirmRestore(): Promise<void> {
    const pt = this.rsPoint;
    if (!pt || !this.restoreTarget) return;
    const toNew = this.rs.where === 'new';
    if (!toNew) {
      const ok = await this.confirm.confirm({
        title: `Restore ${this.restoreTarget}?`,
        message: `This stops any container using "${this.restoreTarget}", ERASES its current contents, and replaces them with the backup from ${this.relPast(pt.started_at)}. This cannot be undone.`,
        confirmLabel: 'Restore & overwrite', danger: true,
      });
      if (!ok) return;
    }
    const target = toNew ? this.rs.newName.trim() : undefined;
    this.notify.info('Restore started…');
    this.docker.restoreVolumeBackup(pt.volume_name!, pt.backup_id!, target).subscribe({
      next: () => { this.notify.success(toNew ? `Restored into ${target}` : `Restored ${this.restoreTarget}`); this.restoreTarget = null; this.load(); },
      error: (e) => this.notify.error(e?.error?.error || 'Restore failed'),
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────────
  openSettings(): void {
    const app = this.policies.find(p => p.kind === 'app');
    this.sg = { enabled: app?.enabled || false, interval: app?.interval_hours || 24, keep: app?.keep || 7 };
    this.showSettings = true;
  }
  saveSettings(): void {
    this.savingSettings = true;
    this.docker.setAppBackupSchedule({ enabled: this.sg.enabled, interval_hours: this.sg.interval, keep: this.sg.keep }).subscribe({
      next: () => { this.notify.success('Settings saved'); this.savingSettings = false; this.showSettings = false; this.load(); },
      error: (e) => { this.notify.error(e?.error?.error || 'Could not save settings'); this.savingSettings = false; },
    });
  }

  // ── formatting helpers ───────────────────────────────────────────────────────
  formatBytes(b: number | null | undefined): string {
    if (b == null) return '—';
    if (b <= 0) return '0 B';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }
  relPast(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso).getTime();
    if (isNaN(d)) return '—';
    const s = Math.max(0, (Date.now() - d) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  relFuture(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso).getTime();
    if (isNaN(d)) return '—';
    const s = (d - Date.now()) / 1000;
    if (s <= 0) return 'due now';
    if (s < 3600) return `in ${Math.floor(s / 60)}m`;
    if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `in ${Math.floor(s / 86400)}d`;
  }

  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ContextMenuService, ContextMenuItem } from '../../services/context-menu.service';
import { AuthService } from '../../auth/auth.service';
import { VolumeSummary } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { LongPressDirective } from '../../directives/long-press.directive';
import { ResponsiveService } from '../../services/responsive.service';
import { PruneDialogService } from '../../services/prune-dialog.service';
import { VolumeExplorerComponent } from './volume-explorer.component';
import { ExplorerVolume } from './volume-explorer.data';

@Component({
  selector: 'app-volume-list',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LongPressDirective, VolumeExplorerComponent],
  templateUrl: './volume-list.component.html',
})
export class VolumeListComponent implements OnInit {
  volumes: VolumeSummary[] = [];
  filtered: VolumeSummary[] = [];
  loading = false;
  q = '';
  volFilter: 'all' | 'used' | 'orphaned' = 'all';

  /** When set, the volume file-explorer takes over the page for this volume. */
  opened: ExplorerVolume | null = null;
  /** Which explorer tab to open on (deep-link from the context menu). */
  explorerTab: 'files' | 'overview' | 'backups' = 'files';

  /** Open the file explorer for a volume (click a row → browse its directories). */
  open(vol: VolumeSummary, tab: 'files' | 'overview' | 'backups' = 'files'): void {
    this.explorerTab = tab;
    this.opened = {
      name: vol.Name,
      driver: vol.Driver,
      mount: vol.Mountpoint,
      size: this.volSize(vol),
      used: this.isOrphaned(vol) ? null : 'in use',
      created: this.fmtDate(vol.CreatedAt),
    };
  }

  private fmtDate(iso?: string): string {
    if (!iso) return '—';
    const dt = new Date(iso);
    return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  get usedCount(): number { return this.volumes.filter(v => (v.UsageData?.RefCount ?? 0) > 0).length; }
  get orphanedCount(): number { return this.volumes.filter(v => this.isOrphaned(v)).length; }
  get reclaimable(): string {
    const orphaned = this.volumes.filter(v => this.isOrphaned(v));
    const bytes = orphaned.reduce((s, v) => s + (v.UsageData?.Size ?? 0), 0);
    return bytes > 0 ? this.formatBytes(bytes) + ' reclaimable' : '';
  }

  isOrphaned(vol: VolumeSummary): boolean {
    return (vol.UsageData?.RefCount ?? -1) === 0;
  }

  volSize(vol: VolumeSummary): string {
    const sz = vol.UsageData?.Size;
    return sz != null && sz >= 0 ? this.formatBytes(sz) : '—';
  }

  formatBytes(b: number): string {
    if (!b || b < 0) return '0 B';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  constructor(private docker: DockerService, private notify: NotificationService, private confirm: ConfirmDialogService, private ctxMenu: ContextMenuService, public auth: AuthService, public responsive: ResponsiveService, private pruneDialog: PruneDialogService) {}
  ngOnInit(): void { this.load(); }

  // ── Context menu ───────────────────────────────────────────────────────────────

  private copyText(text: string, label: string): void {
    try { navigator.clipboard?.writeText(text || ''); } catch { /* clipboard unavailable */ }
    this.notify.info(`Copied ${label}`);
  }

  volumeMenu(e: MouseEvent, vol: VolumeSummary): void {
    const w = this.auth.canWrite();
    const items: ContextMenuItem[] = [
      { label: 'Browse files', icon: 'folder-open', accent: true, onSelect: () => this.open(vol) },
      { label: 'Back up…', icon: 'archive', onSelect: () => this.open(vol, 'backups') },
      { type: 'separator' },
      {
        label: 'Copy', icon: 'copy', items: [
          { label: 'Name', icon: 'tag', onSelect: () => this.copyText(vol.Name, 'name') },
          { label: 'Mount point', icon: 'folder', onSelect: () => this.copyText(vol.Mountpoint, 'mount point') },
          { label: 'Driver', icon: 'hard-drive', onSelect: () => this.copyText(vol.Driver, 'driver') },
        ],
      },
    ];
    if (w) {
      items.push({ type: 'separator' });
      items.push({ label: 'Remove volume', icon: 'trash-2', danger: true, onSelect: () => this.remove(vol) });
    }
    this.ctxMenu.open(e, items, { header: { name: vol.Name, meta: vol.Driver, icon: 'database' } });
  }

  load(): void {
    this.loading = true;
    this.docker.listVolumes().subscribe({
      next: r => { this.volumes = r.Volumes; this.filter(); this.loading = false; },
      error: () => { this.notify.error('Failed to load volumes'); this.loading = false; },
    });
  }

  filter(): void {
    let base = this.volumes;
    if (this.volFilter === 'used') base = base.filter(v => (v.UsageData?.RefCount ?? 0) > 0);
    else if (this.volFilter === 'orphaned') base = base.filter(v => this.isOrphaned(v));
    const s = this.q.toLowerCase();
    this.filtered = s ? base.filter(v => v.Name.toLowerCase().includes(s) || v.Driver.toLowerCase().includes(s)) : [...base];
  }

  async remove(vol: VolumeSummary): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove volume "${vol.Name}"?`,
      message: 'Volume data will be permanently lost.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.docker.removeVolume(vol.Name, false).subscribe({
      next: () => { this.notify.success(`Removed ${vol.Name}`); this.load(); },
      error: () => this.notify.error(`Failed to remove ${vol.Name}`),
    });
  }

  async prune(): Promise<void> {
    const isAnon = (name: string) => /^[0-9a-f]{64}$/.test(name);
    const orphaned = this.volumes.filter(v => this.isOrphaned(v));
    const anonUnused = orphaned.filter(v => isAnon(v.Name));
    const bytes = (arr: VolumeSummary[]) => arr.reduce((s, v) => s + (v.UsageData?.Size ?? 0), 0);

    const changed = await this.pruneDialog.open({
      kind: 'volumes',
      title: 'Prune volumes',
      noun: 'volume',
      scopes: [
        { all: false, label: 'Anonymous only', count: anonUnused.length, bytes: bytes(anonUnused), note: 'Docker-generated unused volumes' },
        { all: true,  label: 'All unused',      count: orphaned.length,   bytes: bytes(orphaned),   note: 'Includes named volumes', danger: true },
      ],
      warning: 'Removes ALL unused volumes including named ones. Their data is permanently deleted and cannot be recovered.',
      run: (all) => this.docker.pruneVolumes(all),
    });
    if (changed) this.load();
  }
}

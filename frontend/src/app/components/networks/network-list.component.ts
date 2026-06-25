import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ContextMenuService, ContextMenuItem } from '../../services/context-menu.service';
import { AuthService } from '../../auth/auth.service';
import { NetworkResource } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { LongPressDirective } from '../../directives/long-press.directive';
import { ResponsiveService } from '../../services/responsive.service';

const SYSTEM_NETS = new Set(['bridge', 'host', 'none']);

@Component({
  selector: 'app-network-list',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LongPressDirective],
  templateUrl: './network-list.component.html',
})
export class NetworkListComponent implements OnInit {
  networks: NetworkResource[] = [];
  filtered: NetworkResource[] = [];
  loading = false;
  q = '';
  netFilter: 'all' | 'user' | 'system' = 'all';

  get userCount(): number { return this.networks.filter(n => !this.isSystem(n)).length; }
  get systemCount(): number { return this.networks.filter(n => this.isSystem(n)).length; }

  isSystem(n: NetworkResource): boolean { return SYSTEM_NETS.has(n.Name.toLowerCase()); }
  containerCount(n: NetworkResource): string {
    const c = n.Containers ? Object.keys(n.Containers).length : 0;
    return c > 0 ? String(c) : '—';
  }

  constructor(private docker: DockerService, private notify: NotificationService, private confirm: ConfirmDialogService, private ctxMenu: ContextMenuService, public auth: AuthService, public responsive: ResponsiveService) {}
  ngOnInit(): void { this.load(); }

  // ── Context menu ───────────────────────────────────────────────────────────────

  private copyText(text: string, label: string): void {
    try { navigator.clipboard?.writeText(text || ''); } catch { /* clipboard unavailable */ }
    this.notify.info(`Copied ${label}`);
  }

  networkMenu(e: MouseEvent, n: NetworkResource): void {
    const w = this.auth.canWrite();
    const items: ContextMenuItem[] = [
      {
        label: 'Copy', icon: 'copy', items: [
          { label: 'Network ID', icon: 'hash', onSelect: () => this.copyText(n.Id, 'network ID') },
          { label: 'Name', icon: 'tag', onSelect: () => this.copyText(n.Name, 'name') },
          { label: 'Subnet', icon: 'route', onSelect: () => this.copyText(this.subnet(n), 'subnet') },
        ],
      },
    ];
    if (w && !this.isSystem(n)) {
      items.push({ type: 'separator' });
      items.push({ label: 'Remove network', icon: 'trash-2', danger: true, onSelect: () => this.remove(n) });
    }
    this.ctxMenu.open(e, items, { header: { name: n.Name, meta: n.Driver, icon: 'network' } });
  }

  load(): void {
    this.loading = true;
    this.docker.listNetworks().subscribe({
      next: n => { this.networks = n; this.filter(); this.loading = false; },
      error: () => { this.notify.error('Failed to load networks'); this.loading = false; },
    });
  }

  filter(): void {
    let base = this.networks;
    if (this.netFilter === 'user') base = base.filter(n => !this.isSystem(n));
    else if (this.netFilter === 'system') base = base.filter(n => this.isSystem(n));
    const s = this.q.toLowerCase();
    this.filtered = s ? base.filter(n => n.Name.toLowerCase().includes(s) || n.Driver.toLowerCase().includes(s) || n.Id.toLowerCase().includes(s)) : [...base];
  }

  async remove(n: NetworkResource): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove network "${n.Name}"?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.docker.removeNetwork(n.Id).subscribe({
      next: () => { this.notify.success(`Removed ${n.Name}`); this.load(); },
      error: () => this.notify.error(`Failed to remove ${n.Name}`),
    });
  }

  async prune(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Prune unused networks?',
      message: 'All networks not in use by a container will be removed.',
      confirmLabel: 'Prune',
      danger: true,
    });
    if (!ok) return;
    this.docker.pruneNetworks().subscribe({
      next: () => { this.notify.success('Unused networks pruned'); this.load(); },
      error: () => this.notify.error('Prune failed'),
    });
  }

  subnet(n: NetworkResource): string {
    const cfg = n.IPAM?.Config;
    return cfg && cfg.length ? cfg[0].Subnet || '—' : '—';
  }

  gateway(n: NetworkResource): string {
    const cfg = n.IPAM?.Config;
    return cfg && cfg.length ? cfg[0].Gateway || '—' : '—';
  }
}

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { DockerService } from '../../../services/docker.service';
import { WebSocketService } from '../../../services/websocket.service';
import { NotificationService } from '../../../services/notification.service';
import { ConfirmDialogService } from '../../../services/confirm-dialog.service';
import { ContainerInspect, ContainerStats } from '../../../models/docker.models';
import { IconComponent } from '../../shared/icon/icon.component';
import { StatusDotComponent, statusTone } from '../../shared/status-dot/status-dot.component';

@Component({
  selector: 'app-container-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, StatusDotComponent],
  templateUrl: './container-detail.component.html',
})
export class ContainerDetailComponent implements OnInit, OnDestroy {
  containerId = '';
  containerName = '';
  tab: 'overview' | 'logs' | 'stats' = 'overview';
  inspect: ContainerInspect | null = null;
  stats: ContainerStats | null = null;
  logLines: string[] = [];
  liveLog = false;
  private logSub?: Subscription;
  private statsSub?: Subscription;

  get cpuPercent(): string {
    if (!this.stats) return '0.0';
    const cpu = this.stats.cpu_stats.cpu_usage.total_usage - this.stats.precpu_stats.cpu_usage.total_usage;
    const sys = this.stats.cpu_stats.system_cpu_usage - this.stats.precpu_stats.system_cpu_usage;
    const ncpu = this.stats.cpu_stats.online_cpus || 1;
    return sys > 0 ? ((cpu / sys) * ncpu * 100).toFixed(1) : '0.0';
  }
  get memUsage(): string { return this.formatBytes(this.stats?.memory_stats?.usage); }
  get netRx(): string {
    if (!this.stats?.networks) return '0 B';
    return this.formatBytes(Object.values(this.stats.networks).reduce((a, n) => a + n.rx_bytes, 0));
  }
  get netTx(): string {
    if (!this.stats?.networks) return '0 B';
    return this.formatBytes(Object.values(this.stats.networks).reduce((a, n) => a + n.tx_bytes, 0));
  }

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private docker: DockerService,
    private ws: WebSocketService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
  ) {}

  ngOnInit(): void {
    this.containerId = this.route.snapshot.paramMap.get('id') ?? '';
    this.docker.inspectContainer(this.containerId).subscribe({
      next: i => { this.inspect = i; this.containerName = i.Name?.replace('/', '') ?? this.containerId.slice(0, 12); },
      error: () => this.notify.error('Failed to load container'),
    });
  }

  ngOnDestroy(): void { this.stopStreams(); }

  statusTone = statusTone;
  back(): void { this.router.navigate(['/containers']); }

  start():   void { this.docker.startContainer(this.containerId).subscribe({ next: () => { this.notify.success('Started'); this.ngOnInit(); }, error: () => this.notify.error('Start failed') }); }
  stop():    void { this.docker.stopContainer(this.containerId).subscribe({ next: () => { this.notify.success('Stopped'); this.ngOnInit(); }, error: () => this.notify.error('Stop failed') }); }
  restart(): void { this.docker.restartContainer(this.containerId).subscribe({ next: () => { this.notify.success('Restarted'); this.ngOnInit(); }, error: () => this.notify.error('Restart failed') }); }

  async remove(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove container "${this.containerName}"?`,
      message: 'The container will be permanently deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.docker.removeContainer(this.containerId, true).subscribe({
      next: () => { this.notify.success('Removed'); this.back(); },
      error: () => this.notify.error('Remove failed'),
    });
  }

  startLogs(): void {
    this.logLines = [];
    this.liveLog = true;
    this.logSub = this.ws.streamLogs(this.containerId, '100').subscribe(line => {
      this.logLines.push(line);
      if (this.logLines.length > 500) this.logLines.shift();
    });
  }

  toggleLogs(): void {
    if (this.liveLog) { this.logSub?.unsubscribe(); this.liveLog = false; }
    else this.startLogs();
  }

  startStats(): void {
    this.statsSub?.unsubscribe();
    this.statsSub = this.ws.streamStats(this.containerId).subscribe(s => { try { this.stats = JSON.parse(s); } catch { /* ignore */ } });
  }

  stopStreams(): void {
    this.logSub?.unsubscribe();
    this.statsSub?.unsubscribe();
  }

  portEntries(ports: Record<string, any>): {host: string; container: string}[] {
    return Object.entries(ports || {}).flatMap(([k, bindings]) =>
      (bindings || []).map((b: any) => ({ host: `${b.HostIp || '0.0.0.0'}:${b.HostPort}`, container: k }))
    );
  }

  formatBytes(bytes?: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  }
}

import { Component, Input, Output, EventEmitter, OnChanges, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../icon/icon.component';
import { DockerService } from '../../../services/docker.service';
import { NotificationService } from '../../../services/notification.service';

interface PaletteCmd {
  icon: string;
  label: string;
  scope: string;
  action?: () => void;
  hot?: string[];
}

@Component({
  selector: 'app-command-palette',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  templateUrl: './command-palette.component.html',
})
export class CommandPaletteComponent implements OnChanges {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();

  query = '';
  selectedIdx = 0;
  filtered: PaletteCmd[] = [];

  private allCmds: PaletteCmd[] = [
    { icon: 'box',         label: 'Go to Containers',           scope: 'navigate',   action: () => this.router.navigate(['/containers']), hot: ['⌘', '1'] },
    { icon: 'layers',      label: 'Go to Images',               scope: 'navigate',   action: () => this.router.navigate(['/images']) },
    { icon: 'database',    label: 'Go to Volumes',              scope: 'navigate',   action: () => this.router.navigate(['/volumes']) },
    { icon: 'network',     label: 'Go to Networks',             scope: 'navigate',   action: () => this.router.navigate(['/networks']) },
    { icon: 'boxes',       label: 'Go to Stacks',               scope: 'navigate',   action: () => this.router.navigate(['/stacks']) },
    { icon: 'hammer',      label: 'Go to Builds',               scope: 'navigate',   action: () => this.router.navigate(['/builds']) },
    { icon: 'cloud',       label: 'Go to Registry',             scope: 'navigate',   action: () => this.router.navigate(['/registry']) },
    { icon: 'scroll-text', label: 'Go to Logs',                 scope: 'navigate',   action: () => this.router.navigate(['/logs']) },
    { icon: 'activity',    label: 'Go to Metrics',              scope: 'navigate',   action: () => this.router.navigate(['/metrics']) },
    { icon: 'rss',         label: 'Go to Events',               scope: 'navigate',   action: () => this.router.navigate(['/events']) },
    { icon: 'trash-2',     label: 'Prune stopped containers',   scope: 'system',     action: () => this.pruneContainers() },
    { icon: 'trash-2',     label: 'Prune unused images',        scope: 'system',     action: () => this.pruneImages() },
    { icon: 'trash-2',     label: 'Prune unused volumes',       scope: 'system',     action: () => this.pruneVolumes() },
    { icon: 'trash-2',     label: 'Prune unused networks',      scope: 'system',     action: () => this.pruneNetworks() },
    { icon: 'download',    label: 'Pull image…',                scope: 'image',      action: () => { this.close(); this.router.navigate(['/images']); } },
  ];

  constructor(
    private router: Router,
    private docker: DockerService,
    private notify: NotificationService,
  ) {}

  ngOnChanges(): void {
    if (this.open) {
      this.query = '';
      this.selectedIdx = 0;
      this.filtered = this.allCmds;
    }
  }

  onQuery(): void {
    const q = this.query.toLowerCase();
    this.filtered = q ? this.allCmds.filter(c => c.label.toLowerCase().includes(q)) : this.allCmds;
    this.selectedIdx = 0;
  }

  moveSelection(dir: number): void {
    this.selectedIdx = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIdx + dir));
  }

  runSelected(): void {
    if (this.filtered[this.selectedIdx]) this.run(this.filtered[this.selectedIdx]);
  }

  run(cmd: PaletteCmd): void {
    this.close();
    cmd.action?.();
  }

  close(): void {
    this.closed.emit();
  }

  highlight(label: string): string {
    if (!this.query) return label;
    const i = label.toLowerCase().indexOf(this.query.toLowerCase());
    if (i < 0) return label;
    return label.slice(0, i) + `<mark>${label.slice(i, i + this.query.length)}</mark>` + label.slice(i + this.query.length);
  }

  private pruneContainers(): void {
    this.docker.pruneContainers().subscribe({
      next: () => this.notify.success('Stopped containers pruned'),
      error: () => this.notify.error('Prune failed'),
    });
  }

  private pruneImages(): void {
    this.docker.pruneImages().subscribe({
      next: () => this.notify.success('Unused images pruned'),
      error: () => this.notify.error('Prune failed'),
    });
  }

  private pruneVolumes(): void {
    this.docker.pruneVolumes().subscribe({
      next: () => this.notify.success('Unused volumes pruned'),
      error: () => this.notify.error('Prune failed'),
    });
  }

  private pruneNetworks(): void {
    this.docker.pruneNetworks().subscribe({
      next: () => this.notify.success('Unused networks pruned'),
      error: () => this.notify.error('Prune failed'),
    });
  }
}

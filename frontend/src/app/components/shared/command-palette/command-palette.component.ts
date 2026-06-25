import { Component, Input, Output, EventEmitter, OnChanges, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { IconComponent } from '../icon/icon.component';
import { DockerService } from '../../../services/docker.service';
import { PruneDialogService } from '../../../services/prune-dialog.service';
import { ImageSummary, VolumeSummary } from '../../../models/docker.models';

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
    private pruneDialog: PruneDialogService,
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

  // The palette has no list loaded, so each action fetches the counts it needs and
  // then opens the same shared prune dialog the list pages use (confirm + scope
  // toggle + itemized result) — no more silent one-keystroke destructive prunes.
  private async pruneContainers(): Promise<void> {
    const list = await firstValueFrom(this.docker.listContainers(true)).catch(() => [] as any[]);
    const stopped = (list || []).filter((c: any) => ['created', 'exited', 'dead'].includes(c.State));
    await this.pruneDialog.open({
      kind: 'containers', title: 'Prune stopped containers', noun: 'container',
      scopes: [{ all: false, label: 'Stopped', count: stopped.length, bytes: 0, note: 'All stopped (exited/created) containers' }],
      run: () => this.docker.pruneContainers(),
    });
  }

  private async pruneImages(): Promise<void> {
    const imgs = await firstValueFrom(this.docker.listImages()).catch(() => [] as ImageSummary[]);
    const isDangling = (img: ImageSummary) => { const t = img.RepoTags || []; return t.length === 0 || t.every(x => x === '<none>:<none>'); };
    const danglingUnused = (imgs || []).filter(i => isDangling(i) && i.Containers <= 0);
    const allUnused = (imgs || []).filter(i => i.Containers <= 0);
    const sum = (a: ImageSummary[]) => a.reduce((s, i) => s + (i.Size || 0), 0);
    await this.pruneDialog.open({
      kind: 'images', title: 'Prune images', noun: 'image',
      scopes: [
        { all: false, label: 'Dangling only', count: danglingUnused.length, bytes: sum(danglingUnused), note: 'Untagged leftover layers' },
        { all: true,  label: 'All unused',     count: allUnused.length,      bytes: sum(allUnused),      note: 'Every image not used by a container', danger: true },
      ],
      warning: 'Also removes tagged images not used by ANY container — including base images of stopped stacks (e.g. postgres:16). You may need to re-pull them.',
      run: (all) => this.docker.pruneImages(all),
    });
  }

  private async pruneVolumes(): Promise<void> {
    const resp = await firstValueFrom(this.docker.listVolumes()).catch(() => null);
    const vols = (resp?.Volumes || []);
    const isAnon = (n: string) => /^[0-9a-f]{64}$/.test(n);
    const isOrphan = (v: VolumeSummary) => (v.UsageData?.RefCount ?? -1) === 0;
    const orphaned = vols.filter(isOrphan);
    const anonUnused = orphaned.filter(v => isAnon(v.Name));
    const bytes = (a: VolumeSummary[]) => a.reduce((s, v) => s + (v.UsageData?.Size ?? 0), 0);
    await this.pruneDialog.open({
      kind: 'volumes', title: 'Prune volumes', noun: 'volume',
      scopes: [
        { all: false, label: 'Anonymous only', count: anonUnused.length, bytes: bytes(anonUnused), note: 'Docker-generated unused volumes' },
        { all: true,  label: 'All unused',      count: orphaned.length,   bytes: bytes(orphaned),   note: 'Includes named volumes', danger: true },
      ],
      warning: 'Removes ALL unused volumes including named ones. Their data is permanently deleted and cannot be recovered.',
      run: (all) => this.docker.pruneVolumes(all),
    });
  }

  private async pruneNetworks(): Promise<void> {
    const nets = await firstValueFrom(this.docker.listNetworks()).catch(() => [] as any[]);
    const SYS = new Set(['bridge', 'host', 'none']);
    const unused = (nets || []).filter((n: any) => !SYS.has((n.Name || '').toLowerCase()) && (!n.Containers || Object.keys(n.Containers).length === 0));
    await this.pruneDialog.open({
      kind: 'networks', title: 'Prune networks', noun: 'network',
      scopes: [{ all: false, label: 'Unused', count: unused.length, bytes: 0, note: 'User-defined networks with no containers attached' }],
      run: () => this.docker.pruneNetworks(),
    });
  }
}

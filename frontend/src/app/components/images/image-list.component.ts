import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ContextMenuService, ContextMenuItem } from '../../services/context-menu.service';
import { AuthService } from '../../auth/auth.service';
import { ImageSummary } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { LongPressDirective } from '../../directives/long-press.directive';
import { ResponsiveService } from '../../services/responsive.service';
import { PruneDialogService } from '../../services/prune-dialog.service';

@Component({
  selector: 'app-image-list',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LongPressDirective],
  styleUrls: ['./image-list.component.scss'],
  templateUrl: './image-list.component.html',
})
export class ImageListComponent implements OnInit {
  readonly cols = '36px 1.7fr 90px 90px 100px 36px';

  images: ImageSummary[] = [];
  filtered: ImageSummary[] = [];
  loading = false;
  pulling = false;
  pullRef = '';
  showPullBar = false;
  imageFilter: 'all' | 'used' | 'unused' = 'all';
  selectedId: string | null = null;
  checkedIds = new Set<string>();

  // Lazy-loaded layer counts: image id → layer count
  layerCounts = new Map<string, number>();

  get usedCount(): number {
    return this.images.filter(i => i.Containers > 0).length;
  }

  get unusedCount(): number {
    return this.images.filter(i => i.Containers <= 0).length;
  }

  get toolbarMeta(): string {
    const total = this.images.reduce((s, i) => s + (i.Size || 0), 0);
    const reclaimable = this.images
      .filter(i => i.Containers <= 0)
      .reduce((s, i) => s + (i.Size || 0), 0);
    const totalStr = this.formatSize(total);
    const reclaimStr = this.formatSize(reclaimable);
    return reclaimable > 0
      ? `${totalStr} total · ${reclaimStr} reclaimable`
      : `${totalStr} total`;
  }

  constructor(private docker: DockerService, private notify: NotificationService, private confirm: ConfirmDialogService, private ctxMenu: ContextMenuService, public auth: AuthService, public responsive: ResponsiveService, private pruneDialog: PruneDialogService) {}

  ngOnInit(): void { this.load(); }

  // ── Context menu ───────────────────────────────────────────────────────────────

  private copyText(text: string, label: string): void {
    try { navigator.clipboard?.writeText(text || ''); } catch { /* clipboard unavailable */ }
    this.notify.info(`Copied ${label}`);
  }

  private hasRealTag(img: ImageSummary): boolean {
    const tags = img.RepoTags || [];
    return tags.length > 0 && !tags.every(t => t === '<none>:<none>');
  }

  pullLatest(img: ImageSummary): void {
    const ref = this.repoTag(img);
    this.docker.pullImage(ref).subscribe({
      next: () => { this.notify.success(`Pulled ${ref}`); this.load(); },
      error: () => this.notify.error(`Pull failed — ${ref}`),
    });
  }

  imageMenu(e: MouseEvent, img: ImageSummary): void {
    const w = this.auth.canWrite();
    const items: ContextMenuItem[] = [];
    if (w && this.hasRealTag(img)) {
      items.push({ label: 'Pull latest', icon: 'download', onSelect: () => this.pullLatest(img) });
      items.push({ type: 'separator' });
    }
    items.push({
      label: 'Copy', icon: 'copy', items: [
        { label: 'Image ID', icon: 'hash', onSelect: () => this.copyText(img.Id.replace('sha256:', ''), 'image ID') },
        { label: 'Repository:tag', icon: 'tag', onSelect: () => this.copyText(this.repoTag(img), 'image tag') },
        { label: 'Digest', icon: 'fingerprint', onSelect: () => this.copyText(this.shortDigest(img), 'digest') },
      ],
    });
    if (w) {
      items.push({ type: 'separator' });
      items.push({ label: 'Remove image', icon: 'trash-2', danger: true, onSelect: () => this.removeImage(img) });
    }
    this.ctxMenu.open(e, items, { header: { name: this.repoName(img), meta: this.repoTag(img), icon: 'layers' } });
  }

  load(): void {
    this.loading = true;
    this.docker.listImages().subscribe({
      next: imgs => {
        this.images = imgs;
        this.applyFilter();
        this.loading = false;
      },
      error: () => { this.notify.error('Failed to load images'); this.loading = false; },
    });
  }

  applyFilter(): void {
    let base = this.images;
    if (this.imageFilter === 'used')   base = base.filter(i => i.Containers > 0);
    if (this.imageFilter === 'unused') base = base.filter(i => i.Containers <= 0);
    this.filtered = [...base];
  }

  select(img: ImageSummary): void {
    this.selectedId = this.selectedId === img.Id ? null : img.Id;
  }

  toggleAll(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (checked) this.filtered.forEach(i => this.checkedIds.add(i.Id));
    else this.checkedIds.clear();
  }

  toggleCheck(id: string, event: Event): void {
    if ((event.target as HTMLInputElement).checked) this.checkedIds.add(id);
    else this.checkedIds.delete(id);
  }

  clearChecks(): void { this.checkedIds.clear(); }

  async bulkRemove(): Promise<void> {
    const ids = [...this.checkedIds];
    if (!ids.length) return;
    const ok = await this.confirm.confirm({
      title: `Remove ${ids.length} image${ids.length > 1 ? 's' : ''}?`,
      message: 'Selected images will be force-removed. Images in use may be skipped.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    const tasks = ids.map(id => this.docker.removeImage(id, true).pipe(
      map(() => true), catchError(() => of(false)),
    ));
    forkJoin(tasks).subscribe(results => {
      const okCount = results.filter(Boolean).length;
      const failCount = results.length - okCount;
      if (okCount) this.notify.success(`Removed ${okCount} image${okCount > 1 ? 's' : ''}`);
      if (failCount) this.notify.error(`${failCount} could not be removed (in use?)`);
      this.clearChecks();
      this.load();
    });
  }

  pullImage(): void {
    if (!this.pullRef.trim()) return;
    this.pulling = true;
    this.docker.pullImage(this.pullRef.trim()).subscribe({
      next: () => {
        this.notify.success(`Pulled ${this.pullRef}`);
        this.pullRef = '';
        this.pulling = false;
        this.showPullBar = false;
        this.load();
      },
      error: () => { this.notify.error('Pull failed'); this.pulling = false; },
    });
  }

  async removeImage(img: ImageSummary): Promise<void> {
    const tag = this.repoTag(img);
    const multiTagged = (img.RepoTags || []).length > 1;
    const message = multiTagged
      ? `"${tag}" has ${img.RepoTags!.length} tags — all will be removed.`
      : undefined;
    const ok = await this.confirm.confirm({ title: `Remove ${tag}?`, message, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    this.docker.removeImage(img.Id, true).subscribe({
      next: () => { this.notify.success(`Removed ${tag}`); this.load(); },
      error: () => this.notify.error(`Failed to remove ${tag}`),
    });
  }

  async pruneImages(): Promise<void> {
    const isDangling = (img: ImageSummary) => {
      const tags = img.RepoTags || [];
      return tags.length === 0 || tags.every(t => t === '<none>:<none>');
    };
    const danglingUnused = this.images.filter(i => isDangling(i) && i.Containers <= 0);
    const allUnused = this.images.filter(i => i.Containers <= 0);
    const sum = (arr: ImageSummary[]) => arr.reduce((s, i) => s + (i.Size || 0), 0);

    const changed = await this.pruneDialog.open({
      kind: 'images',
      title: 'Prune images',
      noun: 'image',
      scopes: [
        { all: false, label: 'Dangling only', count: danglingUnused.length, bytes: sum(danglingUnused), note: 'Untagged leftover layers' },
        { all: true,  label: 'All unused',     count: allUnused.length,      bytes: sum(allUnused),      note: 'Every image not used by a container', danger: true },
      ],
      warning: 'Also removes tagged images not used by ANY container — including base images of stopped stacks (e.g. postgres:16). You may need to re-pull them.',
      run: (all) => this.docker.pruneImages(all),
    });
    if (changed) this.load();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  repoTag(img: ImageSummary): string {
    const tags = img.RepoTags || [];
    return tags.length ? tags[0] : img.Id.replace('sha256:', '').slice(0, 12);
  }

  repoName(img: ImageSummary): string {
    const tag = this.repoTag(img);
    return tag.includes(':') ? tag.split(':')[0] : tag;
  }

  repoTagPart(img: ImageSummary): string {
    const tags = img.RepoTags || [];
    if (!tags.length) return '';
    const tag = tags[0];
    return tag.includes(':') ? tag.split(':').slice(1).join(':') : '';
  }

  shortDigest(img: ImageSummary): string {
    const digests = img.RepoDigests || [];
    if (digests.length) {
      const d = digests[0];
      const hash = d.includes('@sha256:') ? d.split('@sha256:')[1] : d.replace('sha256:', '');
      return hash.slice(0, 12);
    }
    return img.Id.replace('sha256:', '').slice(0, 12);
  }

  layerCount(img: ImageSummary): string {
    const n = this.layerCounts.get(img.Id);
    return n != null ? String(n) : '—';
  }

  formatSize(bytes: number): string {
    if (!bytes || bytes < 0) return '0 B';
    const gb = bytes / 1073741824;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / 1048576;
    if (mb >= 1) return `${mb.toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  timeAgo(ts: number): string {
    const seconds = Math.floor(Date.now() / 1000 - ts);
    if (seconds < 60)   return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    const hours = Math.floor(seconds / 3600);
    if (hours < 24)     return `${hours}h ago`;
    const days = Math.floor(seconds / 86400);
    if (days < 30)      return `${days}d ago`;
    if (days < 365)     return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }
}


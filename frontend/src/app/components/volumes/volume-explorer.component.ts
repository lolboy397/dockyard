import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { ModalComponent } from '../shared/modal/modal.component';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ContextMenuService, ContextMenuItem } from '../../services/context-menu.service';
import {
  ExplorerVolume, VEntry, VFilePreview, VUsage, VolumeBackup, BackupSchedule,
  KIND, TEXT_KINDS, kindForName,
} from './volume-explorer.data';

interface TreeRow { entry: VEntry; path: string[]; depth: number; key: string; isOpen: boolean; isCur: boolean; hasKids: boolean; }

/**
 * Volume Explorer — a file manager that takes over the Volumes content area for
 * a single volume. It browses the volume's *real* contents through the backend
 * file-browser API: a directory tree (lazily loaded per folder), a
 * path-breadcrumbed listing with name search, a slide-in file preview (text
 * inline, images rendered, everything downloadable) and an Overview tab with
 * real size/count/breakdown/mount statistics.
 */
@Component({
  selector: 'app-volume-explorer',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, ModalComponent],
  templateUrl: './volume-explorer.component.html',
  styleUrls: ['./volume-explorer.component.scss'],
})
export class VolumeExplorerComponent implements OnInit, OnDestroy {
  @Input({ required: true }) volume!: ExplorerVolume;
  @Input() initialTab: 'files' | 'overview' | 'backups' = 'files';
  @Output() close = new EventEmitter<void>();

  readonly KIND = KIND;

  tab: 'files' | 'overview' | 'backups' = 'files';

  // ── directory state ────────────────────────────────────────────────────────
  path: string[] = [];
  entries: VEntry[] = [];
  loadingDir = false;
  dirError = '';

  /** Cached directory listings keyed by joined path (root = ''). Drives the tree. */
  private childrenCache = new Map<string, VEntry[]>();
  private loadingKeys = new Set<string>();
  expanded = new Set<string>();

  // ── search ─────────────────────────────────────────────────────────────────
  query = '';
  results: VEntry[] = [];
  searching = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ── preview ──────────────────────────────────────────────────────────────
  sel: { entry: VEntry; path: string[] } | null = null;
  preview: VFilePreview | null = null;
  previewLoading = false;
  previewError = '';
  imageUrl: string | null = null;
  imgDims = '';

  // ── overview ─────────────────────────────────────────────────────────────
  usage: VUsage | null = null;
  usageLoading = false;

  // ── backups ──────────────────────────────────────────────────────────────
  backups: VolumeBackup[] = [];
  backupsLoading = false;
  backupsConfigured = true;
  backupsLoaded = false;
  showBackupForm = false;
  backupNote = '';
  backupStop = true;
  creatingBackup = false;
  busyBackupId: number | null = null; // id currently restoring/deleting

  // automatic-backup schedule
  schedule: BackupSchedule | null = null;
  scheduleForm = { enabled: false, interval_hours: 24, keep: 10, stop_container: true };
  savingSchedule = false;

  constructor(
    private docker: DockerService,
    private ctxMenu: ContextMenuService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
  ) {}

  ngOnInit(): void {
    this.tab = this.initialTab;
    this.loadDir([]);
    this.loadUsage();
    if (this.tab === 'backups') { this.loadBackups(); this.loadSchedule(); }
  }

  setTab(t: 'files' | 'overview' | 'backups'): void {
    this.tab = t;
    if (t === 'backups' && !this.backupsLoaded) { this.loadBackups(); this.loadSchedule(); }
  }

  ngOnDestroy(): void {
    this.revokeImage();
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  // ── loading ──────────────────────────────────────────────────────────────
  private keyOf(p: string[]): string { return p.join('/'); }

  private loadDir(p: string[]): void {
    this.loadingDir = true;
    this.dirError = '';
    this.docker.listVolumeFiles(this.volume.name, this.keyOf(p)).subscribe({
      next: r => {
        const sorted = this.sortEntries(r.entries || []);
        this.childrenCache.set(this.keyOf(p), sorted);
        if (this.keyOf(p) === this.keyOf(this.path)) this.entries = sorted;
        this.loadingDir = false;
      },
      error: e => {
        this.dirError = e?.error?.error || 'Could not read this folder';
        this.entries = [];
        this.loadingDir = false;
      },
    });
  }

  /** Fetch a directory's children for the tree (no navigation). */
  private fetchChildren(p: string[]): void {
    const key = this.keyOf(p);
    if (this.childrenCache.has(key) || this.loadingKeys.has(key)) return;
    this.loadingKeys.add(key);
    this.docker.listVolumeFiles(this.volume.name, key).subscribe({
      next: r => { this.childrenCache.set(key, this.sortEntries(r.entries || [])); this.loadingKeys.delete(key); },
      error: () => { this.childrenCache.set(key, []); this.loadingKeys.delete(key); },
    });
  }

  private loadUsage(): void {
    this.usageLoading = true;
    this.docker.getVolumeUsage(this.volume.name).subscribe({
      next: u => { this.usage = u; this.usageLoading = false; },
      error: () => { this.usageLoading = false; },
    });
  }

  private sortEntries(list: VEntry[]): VEntry[] {
    return [...list].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  // ── navigation ─────────────────────────────────────────────────────────────
  nav(p: string[]): void {
    this.path = p;
    this.sel = null;
    this.clearPreview();
    this.query = '';
    this.results = [];
    const cached = this.childrenCache.get(this.keyOf(p));
    this.entries = cached ? cached : [];
    this.loadDir(p);
  }

  openDir(name: string): void {
    const p = [...this.path, name];
    this.expanded.add(this.keyOf(p));
    this.nav(p);
  }

  toggle(key: string, p: string[]): void {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else { this.expanded.add(key); this.fetchChildren(p); }
  }

  treeClick(row: TreeRow): void {
    this.nav(row.path);
    this.expanded.add(row.key);
    this.fetchChildren(row.path);
  }

  chevronClick(row: TreeRow, e: Event): void {
    e.stopPropagation();
    this.toggle(row.key, row.path);
  }

  // ── tree ───────────────────────────────────────────────────────────────────
  get treeRows(): TreeRow[] {
    const out: TreeRow[] = [];
    const curKey = this.keyOf(this.path);
    const walk = (parentPath: string[], depth: number) => {
      const kids = this.childrenCache.get(this.keyOf(parentPath));
      if (!kids) return;
      for (const n of kids) {
        if (n.type !== 'dir') continue;
        const p = [...parentPath, n.name];
        const key = this.keyOf(p);
        const childKids = this.childrenCache.get(key);
        const hasKids = childKids ? childKids.some(c => c.type === 'dir') : true;
        out.push({ entry: n, path: p, depth, key, isOpen: this.expanded.has(key), isCur: key === curKey, hasKids });
        if (this.expanded.has(key)) walk(p, depth + 1);
      }
    };
    walk([], 1);
    return out;
  }
  treePad(depth: number): number { return 6 + depth * 14; }

  // ── listing helpers ─────────────────────────────────────────────────────────
  pathOf(entry: VEntry): string[] {
    return entry.path ? entry.path.split('/') : [...this.path, entry.name];
  }
  childPath(name: string): string[] { return [...this.path, name]; }
  isSelected(p: string[]): boolean { return !!this.sel && this.keyOf(this.sel.path) === this.keyOf(p); }

  rowClick(entry: VEntry): void {
    const segs = this.pathOf(entry);
    if (entry.type === 'dir') this.nav(segs);
    else this.openFile(entry, segs);
  }

  meta(entry: VEntry) {
    if (entry.type === 'dir') return { icon: 'folder', label: '' };
    return KIND[kindForName(entry.name)] || KIND['binary'];
  }
  fileMeta(entry: VEntry) { return KIND[kindForName(entry.name)] || KIND['binary']; }
  rowSize(entry: VEntry): string { return entry.type === 'dir' ? '—' : this.formatBytes(entry.size); }

  formatBytes(b: number): string {
    if (b == null) return '—';
    if (b <= 0) return '0 B';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  formatDate(s: number): string {
    if (!s) return '—';
    const d = new Date(s * 1000);
    if (isNaN(d.getTime())) return '—';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString('en-US', sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── search ───────────────────────────────────────────────────────────────
  get q(): string { return this.query.trim().toLowerCase(); }

  onQueryChange(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const term = this.query.trim();
    if (!term) { this.results = []; this.searching = false; return; }
    this.searching = true;
    this.searchTimer = setTimeout(() => {
      this.docker.searchVolumeFiles(this.volume.name, term).subscribe({
        next: r => { this.results = this.sortEntries(r.entries || []); this.searching = false; },
        error: () => { this.results = []; this.searching = false; },
      });
    }, 250);
  }

  clearQuery(): void { this.query = ''; this.results = []; this.searching = false; }

  // ── preview ──────────────────────────────────────────────────────────────
  openFile(entry: VEntry, filePath: string[]): void {
    this.sel = { entry, path: filePath };
    this.loadPreview(entry, filePath);
  }

  private loadPreview(entry: VEntry, filePath: string[]): void {
    this.clearPreview();
    this.previewLoading = true;
    const rel = this.keyOf(filePath);
    if (kindForName(entry.name) === 'image') {
      this.docker.downloadVolumePath(this.volume.name, rel).subscribe({
        next: resp => { if (resp.body) this.imageUrl = URL.createObjectURL(resp.body); this.previewLoading = false; },
        error: () => { this.previewError = 'Could not load image'; this.previewLoading = false; },
      });
      return;
    }
    this.docker.getVolumeFilePreview(this.volume.name, rel).subscribe({
      next: p => { this.preview = p; this.previewLoading = false; },
      error: e => { this.previewError = e?.error?.error || 'Could not load preview'; this.previewLoading = false; },
    });
  }

  private clearPreview(): void {
    this.revokeImage();
    this.preview = null;
    this.previewError = '';
    this.previewLoading = false;
    this.imgDims = '';
  }
  private revokeImage(): void {
    if (this.imageUrl) { URL.revokeObjectURL(this.imageUrl); this.imageUrl = null; }
  }
  closePreview(): void { this.sel = null; this.clearPreview(); }

  onImgLoad(e: Event): void {
    const img = e.target as HTMLImageElement;
    if (img.naturalWidth) this.imgDims = `${img.naturalWidth} × ${img.naturalHeight}`;
  }

  isText(): boolean { return !!this.preview && !this.preview.binary; }
  lines(content: string): string[] { return content.split('\n'); }
  isComment(line: string): boolean {
    const t = line.trimStart();
    return t.startsWith('#') || t.startsWith('//');
  }
  textKind(entry: VEntry): boolean { return TEXT_KINDS.has(kindForName(entry.name)); }

  // ── overview ─────────────────────────────────────────────────────────────
  get overviewSize(): string { return this.usage ? this.formatBytes(this.usage.size_bytes) : this.volume.size; }

  get breakdownView(): { name: string; size: string; pct: number; tone: string }[] {
    const u = this.usage;
    if (!u || !u.breakdown.length) return [];
    const total = u.size_bytes || u.breakdown.reduce((s, b) => s + b.size_bytes, 0) || 1;
    const tones = ['var(--brand-400)', 'var(--info-400)', 'var(--running-400)', 'var(--warn-400)', 'var(--ink-6)'];
    return u.breakdown.map((b, i) => ({
      name: b.name,
      size: this.formatBytes(b.size_bytes),
      pct: Math.min(100, Math.max(2, Math.round((b.size_bytes / total) * 100))),
      tone: tones[i % tones.length],
    }));
  }

  // ── downloads ──────────────────────────────────────────────────────────────
  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private filenameFromResponse(resp: { headers: { get(name: string): string | null } }, fallback: string): string {
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"]+)"?/.exec(cd);
    return m ? m[1] : fallback;
  }

  download(entry: VEntry): void {
    const rel = this.keyOf(this.pathOf(entry));
    const fallback = entry.type === 'dir' ? `${entry.name}.tar` : entry.name;
    this.notify.info(`Preparing ${entry.name}…`);
    this.docker.downloadVolumePath(this.volume.name, rel).subscribe({
      next: resp => { if (resp.body) this.saveBlob(resp.body, this.filenameFromResponse(resp, fallback)); },
      error: () => this.notify.error(`Could not download ${entry.name}`),
    });
  }

  downloadVolume(): void {
    this.notify.info(`Preparing ${this.volume.name}.tar…`);
    this.docker.downloadVolumePath(this.volume.name, '').subscribe({
      next: resp => { if (resp.body) this.saveBlob(resp.body, this.filenameFromResponse(resp, `${this.volume.name}.tar`)); },
      error: () => this.notify.error('Could not download volume'),
    });
  }

  downloadSelected(): void { if (this.sel) this.download(this.sel.entry); }

  // ── backups ──────────────────────────────────────────────────────────────
  loadBackups(): void {
    this.backupsLoading = true;
    this.docker.listVolumeBackups(this.volume.name).subscribe({
      next: r => { this.backups = r.backups || []; this.backupsConfigured = r.configured; this.backupsLoading = false; this.backupsLoaded = true; },
      error: () => { this.backups = []; this.backupsLoading = false; this.backupsLoaded = true; },
    });
  }

  openBackupForm(): void {
    this.backupNote = '';
    this.backupStop = true;
    this.showBackupForm = true;
  }

  createBackup(): void {
    if (this.creatingBackup) return;
    this.creatingBackup = true;
    this.docker.createVolumeBackup(this.volume.name, { stop_container: this.backupStop, note: this.backupNote.trim() }).subscribe({
      next: () => {
        this.notify.success(`Backed up ${this.volume.name}`);
        this.creatingBackup = false;
        this.showBackupForm = false;
        this.loadBackups();
      },
      error: e => { this.notify.error(e?.error?.error || 'Backup failed'); this.creatingBackup = false; },
    });
  }

  async restoreBackup(b: VolumeBackup): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Restore ${this.volume.name}?`,
      message: `This stops any container using "${this.volume.name}", ERASES its current contents, and replaces them with the backup from ${this.formatBackupDate(b)}. This cannot be undone.`,
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;
    this.busyBackupId = b.id;
    this.docker.restoreVolumeBackup(this.volume.name, b.id).subscribe({
      next: () => { this.notify.success(`Restored ${this.volume.name}`); this.busyBackupId = null; },
      error: e => { this.notify.error(e?.error?.error || 'Restore failed'); this.busyBackupId = null; },
    });
  }

  async deleteBackup(b: VolumeBackup): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete this backup?',
      message: `The archive from ${this.formatBackupDate(b)} will be permanently removed.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    this.busyBackupId = b.id;
    this.docker.deleteVolumeBackup(this.volume.name, b.id).subscribe({
      next: () => { this.notify.info('Backup deleted'); this.busyBackupId = null; this.loadBackups(); },
      error: () => { this.notify.error('Delete failed'); this.busyBackupId = null; },
    });
  }

  downloadBackup(b: VolumeBackup): void {
    this.notify.info('Preparing download…');
    this.docker.downloadVolumeBackup(this.volume.name, b.id).subscribe({
      next: resp => { if (resp.body) this.saveBlob(resp.body, this.filenameFromResponse(resp, `${this.volume.name}-${b.id}.tar.gz`)); },
      error: () => this.notify.error('Could not download backup'),
    });
  }

  formatBackupDate(b: VolumeBackup): string {
    const d = new Date(b.created_at);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── schedule ─────────────────────────────────────────────────────────────
  loadSchedule(): void {
    this.docker.getBackupSchedule(this.volume.name).subscribe({
      next: r => {
        this.schedule = r.schedule;
        if (r.schedule) {
          this.scheduleForm = {
            enabled: r.schedule.enabled,
            interval_hours: r.schedule.interval_hours,
            keep: r.schedule.keep,
            stop_container: r.schedule.stop_container,
          };
        }
      },
      error: () => { /* leave defaults */ },
    });
  }

  saveSchedule(): void {
    if (this.savingSchedule) return;
    this.savingSchedule = true;
    this.docker.setBackupSchedule(this.volume.name, this.scheduleForm).subscribe({
      next: r => {
        this.schedule = r.schedule;
        this.savingSchedule = false;
        this.notify.success(this.scheduleForm.enabled ? 'Automatic backups enabled' : 'Automatic backups disabled');
      },
      error: e => { this.notify.error(e?.error?.error || 'Could not save schedule'); this.savingSchedule = false; },
    });
  }

  scheduleLastRun(): string {
    if (!this.schedule?.last_run_at) return 'never';
    const d = new Date(this.schedule.last_run_at);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── clipboard / context menu ─────────────────────────────────────────────
  copyPath(p: string[]): void {
    const s = '/' + this.keyOf(p);
    try { navigator.clipboard?.writeText(s); } catch { /* clipboard unavailable */ }
    this.notify.info('Copied path — ' + s);
  }
  copySelectedPath(): void { if (this.sel) this.copyPath(this.sel.path); }

  rowMenu(e: MouseEvent, entry: VEntry): void {
    const pathArr = this.pathOf(entry);
    const isDir = entry.type === 'dir';
    const m = this.meta(entry);
    const items: ContextMenuItem[] = isDir ? [
      { label: 'Open', icon: 'folder-open', accent: true, onSelect: () => this.nav(pathArr) },
      { label: 'Download as archive', icon: 'file-archive', onSelect: () => this.download(entry) },
      { label: 'Copy path', icon: 'copy', onSelect: () => this.copyPath(pathArr) },
    ] : [
      { label: 'Open preview', icon: 'eye', accent: true, onSelect: () => this.openFile(entry, pathArr) },
      { label: 'Download', icon: 'download', onSelect: () => this.download(entry) },
      { label: 'Copy path', icon: 'copy', onSelect: () => this.copyPath(pathArr) },
    ];
    this.ctxMenu.open(e, items, {
      header: { name: entry.name, meta: isDir ? 'Folder' : this.formatBytes(entry.size), icon: m.icon },
    });
  }

  onClose(): void { this.close.emit(); }
}

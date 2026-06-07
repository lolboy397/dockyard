import {
  Component, OnInit, OnDestroy, HostListener,
  ChangeDetectionStrategy, ChangeDetectorRef,
  ViewChild, ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { DockerService } from '../../services/docker.service';
import { WebSocketService, DeleteProgressEvent } from '../../services/websocket.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ContextMenuService, ContextMenuItem } from '../../services/context-menu.service';
import {
  Project, ProjectFileNode, GitRepo, GitFileStatus, GitCommit, GitBranch,
} from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { LogViewerComponent } from '../shared/log-viewer/log-viewer.component';
import { ModalComponent } from '../shared/modal/modal.component';

// ─── Types ───────────────────────────────────────────────────────────────────

type Tab     = 'overview' | 'logs' | 'files' | 'source';
type LogTab  = 'build' | 'run';

interface DiffLine {
  type: 'add' | 'remove' | 'hunk' | 'meta' | 'ctx';
  text: string;
}

interface DeleteStepState {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
}

// ─── Component ────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LogViewerComponent, ModalComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  templateUrl: './projects.component.html',
  styleUrls: ['./projects.component.scss'],
})
export class ProjectsComponent implements OnInit, OnDestroy {
  // ── Data ──────────────────────────────────────────────────────────────────
  projects: Project[] = [];
  selected: Project | null = null;
  loading = false;

  // ── UI state ──────────────────────────────────────────────────────────────
  tab: Tab = 'overview';
  logTab: LogTab = 'build';
  searchQuery = '';

  // ── Logs ─────────────────────────────────────────────────────────────────
  buildLog = '';
  runLog = '';
  logWrap = true;

  // ── Action flags ─────────────────────────────────────────────────────────
  building = false;
  buildStep = 0;
  buildTotal = 0;
  running  = false;
  stopping = false;
  filesLoading = false;

  // ── Delete progress ─────────────────────────────────────────────────────────
  deleting = false;
  deleteProjectName = '';
  deleteSteps: DeleteStepState[] = [];
  deleteError = '';
  deleteDone = false;

  // ── Ports ─────────────────────────────────────────────────────────────────
  portsEditing = false;
  portRows: { host: string; container: string }[] = [];
  portConflictBanner = false;
  portConflictPort = '';   // single conflicting port (from WS done event or HTTP error)
  portConflictNewPort = ''; // user-edited replacement port

  // ── Overview stats ────────────────────────────────────────────────────────
  overviewCpu = '';
  overviewMemory = '';
  overviewImageSize = '';
  overviewStatsLoaded = false;

  // ── Files two-pane ────────────────────────────────────────────────────────
  fileTree: ProjectFileNode[] = [];
  expandedNodes = new Set<ProjectFileNode>();
  previewPath = '';
  previewContent = '';
  previewLoading = false;
  fileSearchQuery = '';

  // ── Source / git ─────────────────────────────────────────────────────────
  linkedRepo: GitRepo | null = null;
  gitLoading = false;
  deployOnPush = false;
  dopLoading = false;
  gitFiles: GitFileStatus[] = [];
  diffFile: GitFileStatus | null = null;
  diffLines: DiffLine[] = [];
  commits: GitCommit[] = [];
  historyLoading = false;
  branches: GitBranch[] = [];
  branchesLoading = false;
  branchPickerOpen = false;
  newBranchOpen = false;
  newBranchName = '';
  moreMenuOpen = false;
  commitMsg = '';
  gitAuthorName = '';
  gitAuthorEmail = '';

  // ── Upload modal ──────────────────────────────────────────────────────────
  showUpload = false;
  uploadMode: 'folder' | 'zip' = 'folder';
  uploadFile: File | null = null;
  uploadEntries: File[] = [];
  uploadFolderName = '';
  dragOver = false;
  uploading = false;
  uploadPending = false;
  uploadProcessing = false;
  uploadProgress = 0;
  nameError = '';
  uploadForm = { name: '', description: '', ports: '' };
  uploadPreviewTree: ProjectFileNode[] = [];
  expandedPreviewNodes = new Set<ProjectFileNode>();
  uploadSkippedCount = 0;
  detectedProjectType: string = 'unknown';
  keyFilesFound: string[] = [];
  previewTreeExpanded = true;
  uploadStep: 1 | 2 = 1;
  uploadPortRows: { host: string; container: string }[] = [];
  detectedPorts: { host: string; container: string }[] = [];

  private subs = new Subscription();

  constructor(
    private docker: DockerService,
    private notify: NotificationService,
    private cdr: ChangeDetectorRef,
    private ws: WebSocketService,
    private confirm: ConfirmDialogService,
    private ctxMenu: ContextMenuService,
  ) {}

  // ── Context menu ─────────────────────────────────────────────────────────────

  private copyText(text: string, label: string): void {
    try { navigator.clipboard?.writeText(text || ''); } catch { /* clipboard unavailable */ }
    this.notify.info(`Copied ${label}`);
  }

  /**
   * Right-click project menu — a 1:1 port of `openProjectMenu()` in the
   * design-system ProjectsPage.jsx, wired to the real build/run/stop lifecycle.
   */
  projectMenu(e: MouseEvent, p: Project): void {
    const running = p.status === 'running';
    const built = !!p.image_tag && p.status !== 'failed';
    const primary: ContextMenuItem = running
      ? { label: 'Stop', icon: 'square', onSelect: () => { this.selectProject(p); this.stopProject(); } }
      : { label: built ? 'Run' : 'Build', icon: built ? 'play' : 'hammer', onSelect: () => { this.selectProject(p); if (built) this.runProject(); else this.buildProject(); } };

    const items: ContextMenuItem[] = [
      { label: 'Open', icon: 'layout-panel-left', accent: true, onSelect: () => { this.selectProject(p); this.switchTab('overview'); } },
      { type: 'separator' },
      primary,
      { label: 'Rebuild', icon: 'hammer', disabled: p.status === 'building', onSelect: () => { this.selectProject(p); this.buildProject(); } },
      { label: 'Open in browser', icon: 'external-link', disabled: !running, onSelect: () => { this.selectProject(p); this.openFirstPort(); } },
      { type: 'separator' },
      { label: 'View logs', icon: 'scroll-text', onSelect: () => { this.selectProject(p); this.switchTab('logs'); } },
      { label: 'Source', icon: 'git-branch', onSelect: () => { this.selectProject(p); this.switchTab('source'); } },
      {
        label: 'Copy', icon: 'copy', items: [
          { label: 'Name', icon: 'tag', onSelect: () => this.copyText(p.name, 'name') },
          { label: 'Image tag', icon: 'layers', onSelect: () => this.copyText(p.image_tag || '', 'image tag') },
          { label: 'Branch', icon: 'git-branch', onSelect: () => this.copyText(p.branch || '', 'branch') },
        ],
      },
      { type: 'separator' },
      { label: 'Remove project', icon: 'trash-2', danger: true, onSelect: () => { this.selectProject(p); this.deleteProject(); } },
    ];

    this.ctxMenu.open(e, items, {
      header: {
        name: p.name,
        meta: p.image_tag || (p.type === 'compose' ? 'Compose' : 'Dockerfile'),
        icon: p.type === 'compose' ? 'boxes' : 'file-code',
      },
    });
  }

  ngOnInit(): void {
    this.loadProjects();
  }
  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.branchPickerOpen = false;
    this.moreMenuOpen = false;
  }

  // ── Computed ───────────────────────────────────────────────────────────────

  get runningCount(): number {
    return this.projects.filter(p => p.status === 'running').length;
  }

  get isBuilt(): boolean {
    return !!(this.selected?.image_tag) && this.selected?.status !== 'failed';
  }

  get firstPort(): string {
    const ports = this.parsedPorts();
    return ports.length > 0 ? ports[0].host : '';
  }

  get previewFileName(): string {
    return this.previewPath.split('/').pop() ?? this.previewPath;
  }

  filteredProjects(): Project[] {
    const q = this.searchQuery.toLowerCase().trim();
    if (!q) return this.projects;
    return this.projects.filter(p =>
      p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }

  currentBranch(): string {
    return this.branches.find(b => b.current)?.name ?? this.selected?.branch ?? 'main';
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  loadProjects(): void {
    this.loading = true;
    this.subs.add(
      this.docker.listProjects().subscribe({
        next: projs => {
          this.projects = (projs ?? []).sort((a, b) => a.name.localeCompare(b.name));
          this.loading = false;
        },
        error: () => { this.loading = false; },
      }),
    );
  }

  selectProject(proj: Project): void {
    this.selected = proj;
    this.tab = 'overview';
    this.logTab = 'build';
    this.buildLog = '';
    this.runLog = '';
    this.portConflictBanner = false;
    this.portConflictPort = '';
    this.portConflictNewPort = '';
    this.fileTree = [];
    this.expandedNodes.clear();
    this.linkedRepo = null;
    this.gitFiles = [];
    this.diffFile = null;
    this.diffLines = [];
    this.commits = [];
    this.branches = [];
    this.portsEditing = false;
    this.previewPath = '';
    this.previewContent = '';
    this.overviewCpu = '';
    this.overviewMemory = '';
    this.overviewImageSize = '';
    this.overviewStatsLoaded = false;
    this.building = false;
    this.running = false;
    this.stopping = false;
    this.loadLogs(proj.id);
    this.loadOverviewStats();
    if (proj.repo_id) { this.loadLinkedRepo(proj.repo_id); this.loadDeployHook(proj.id); }
  }

  switchTab(tab: Tab): void {
    this.tab = tab;
    if (tab === 'overview') {
      this.loadOverviewStats();
    } else if (tab === 'files') {
      if (this.selected && this.fileTree.length === 0) this.loadFiles(this.selected.id);
    } else if (tab === 'source') {
      if (this.selected?.repo_id) {
        if (!this.linkedRepo) this.loadLinkedRepo(this.selected.repo_id);
        else { this.loadGitStatus(); this.loadGitHistory(); }
      }
    }
  }

  // ── Overview stats ─────────────────────────────────────────────────────────

  loadOverviewStats(): void {
    if (!this.selected) return;
    this.overviewCpu = '';
    this.overviewMemory = '';
    this.overviewImageSize = '';
    this.overviewStatsLoaded = false;

    if (this.selected.status === 'running' && this.selected.container_id) {
      this.subs.add(
        this.docker.getContainerStats(this.selected.container_id).subscribe({
          next: stats => {
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            const numCPU = stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
            const cpu = numCPU * (cpuDelta / sysDelta) * 100;
            this.overviewCpu = isFinite(cpu) ? cpu.toFixed(2) + '%' : '—';
            const used = stats.memory_stats?.usage ?? 0;
            const limit = stats.memory_stats?.limit ?? 0;
            this.overviewMemory = this.formatBytes(used) + (limit > 0 ? ' / ' + this.formatBytes(limit) : '');
            this.overviewStatsLoaded = true;
          },
          error: () => { this.overviewCpu = '—'; this.overviewMemory = '—'; this.overviewStatsLoaded = true; },
        }),
      );
    }

    if (this.selected.image_tag) {
      this.subs.add(
        this.docker.inspectImage(this.selected.image_tag).subscribe({
          next: img => { this.overviewImageSize = this.formatBytes((img as any).Size ?? (img as any).VirtualSize ?? 0); },
          error: () => { this.overviewImageSize = '—'; },
        }),
      );
    }
  }

  // ── Logs ───────────────────────────────────────────────────────────────────

  loadLogs(id: number): void {
    this.subs.add(
      this.docker.getProject(id).subscribe({
        next: proj => {
          if (this.selected?.id === id) {
            this.buildLog = proj.build_log ?? '';
            this.runLog   = proj.run_log   ?? '';
          }
        },
      }),
    );
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  loadFiles(id: number): void {
    this.filesLoading = true;
    this.subs.add(
      this.docker.getProjectFiles(id).subscribe({
        next: tree => {
          this.fileTree = this.sortTree(tree ?? []);
          this.filesLoading = false;
          this.expandedNodes.clear();
          for (const node of this.fileTree) {
            if (node.type === 'dir') this.expandedNodes.add(node);
          }
          const KEY_PRIORITY = ['Dockerfile','docker-compose.yml','docker-compose.yaml','compose.yml','package.json','go.mod'];
          const first = this.fileTree.find(n => n.type === 'file' && KEY_PRIORITY.includes(n.name));
          if (first) this.selectFileNode(first.name);
        },
        error: () => { this.fileTree = []; this.filesLoading = false; },
      }),
    );
  }

  toggleNode(node: ProjectFileNode): void {
    if (this.expandedNodes.has(node)) this.expandedNodes.delete(node);
    else this.expandedNodes.add(node);
  }

  selectFileNode(path: string): void {
    if (this.previewPath === path) return;
    this.previewPath = path;
    this.previewContent = '';
    this.previewLoading = true;
    this.subs.add(
      this.docker.getProjectFileContent(this.selected!.id, path).subscribe({
        next: content => { this.previewContent = content; this.previewLoading = false; },
        error: () => { this.previewContent = '(Could not load file)'; this.previewLoading = false; },
      }),
    );
  }

  private sortTree(nodes: ProjectFileNode[]): ProjectFileNode[] {
    const sorted = [...nodes].sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'dir' ? -1 : 1;
    });
    return sorted.map(n => n.type === 'dir' && n.children
      ? { ...n, children: this.sortTree(n.children) }
      : n);
  }

  filteredFileTree(): ProjectFileNode[] {
    const q = this.fileSearchQuery.toLowerCase().trim();
    if (!q) return this.fileTree;
    const filter = (nodes: ProjectFileNode[]): ProjectFileNode[] =>
      nodes.reduce((acc: ProjectFileNode[], n) => {
        if (n.type === 'file' && n.name.toLowerCase().includes(q)) { acc.push(n); }
        else if (n.type === 'dir' && n.children) {
          const filtered = filter(n.children);
          if (filtered.length > 0) acc.push({ ...n, children: filtered });
        }
        return acc;
      }, []);
    return filter(this.fileTree);
  }

  flatFileCount(nodes: ProjectFileNode[]): number {
    let c = 0;
    for (const n of nodes) {
      if (n.type === 'file') c++;
      else if (n.children) c += this.flatFileCount(n.children);
    }
    return c;
  }

  isKeyFile(name: string): boolean {
    return ['Dockerfile','docker-compose.yml','docker-compose.yaml','compose.yml',
            'package.json','go.mod','cargo.toml','requirements.txt','.env'].includes(name);
  }

  async copyPreviewContent(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.previewContent);
      this.notify.success('Copied');
    } catch {
      this.notify.error('Failed to copy');
    }
  }

  // ── Build / Run / Stop ─────────────────────────────────────────────────────

  buildProject(): void {
    if (!this.selected) return;
    const id = this.selected.id;
    this.building = true;
    this.buildStep = 0;
    this.buildTotal = 0;
    this.tab = 'logs';
    this.logTab = 'build';
    this.buildLog = '';
    this.setSelectedStatus('building');

    // Trigger the async build, then stream log lines via WebSocket.
    this.subs.add(
      this.docker.buildProject(id).subscribe({
        error: err => {
          this.building = false;
          this.setSelectedStatus('failed');
          this.notify.error('Build failed: ' + (err.error?.error ?? err.message));
        },
        complete: () => {
          this.subs.add(
            this.ws.streamProjectBuildLogs(id).subscribe({
              next: msg => {
                if (!this.selected || this.selected.id !== id) return;
                if (msg.type === 'line') {
                  this.buildLog += (msg.data ?? '') + '\n';
                  // Parse Docker build step progress (legacy: "Step 2/5" or BuildKit: "#4 [2/5]")
                  const line = msg.data ?? '';
                  const legacy = /^Step (\d+)\/(\d+)/.exec(line);
                  const bk = /^#\d+ \[(\d+)\/(\d+)\]/.exec(line);
                  if (legacy) { this.buildStep = +legacy[1]; this.buildTotal = +legacy[2]; }
                  else if (bk) { this.buildStep = +bk[1]; this.buildTotal = +bk[2]; }
                } else if (msg.type === 'done') {
                  this.building = false;
                  const status = msg.status ?? 'idle';
                  this.setSelectedStatus(status as any);
                  if (status === 'failed') {
                    if (msg.port_conflict) {
                      this.portConflictPort = msg.port_conflict;
                      this.portConflictNewPort = String(Number(msg.port_conflict) + 1);
                      this.portConflictBanner = true;
                    } else {
                      this.notify.error('Build failed');
                    }
                  } else {
                    this.notify.success(status === 'running' ? 'Project is running' : 'Build complete');
                    // Build auto-starts the container; jump to the run log when it's up.
                    if (status === 'running') this.logTab = 'run';
                    this.refreshProject();
                  }
                }
              },
              error: () => {
                this.building = false;
                this.setSelectedStatus('failed');
                this.notify.error('Build connection lost');
              },
            }),
          );
        },
      }),
    );
  }

  runProject(): void {
    if (!this.selected) return;
    const id = this.selected.id;
    this.running = true;
    this.building = true;
    this.buildLog = '';
    this.runLog = '';   // backend wipes the DB run log on run start — mirror it so a re-run doesn't show stale output
    this.buildStep = 0;
    this.buildTotal = 0;
    this.tab = 'logs';
    this.logTab = 'build';
    this.setSelectedStatus('building');

    this.subs.add(
      this.docker.runProject(id).subscribe({
        error: err => {
          this.running = false;
          this.building = false;
          this.setSelectedStatus('failed');
          this.notify.error('Run failed: ' + (err.error?.error ?? err.message));
        },
        complete: () => {
          this.subs.add(
            this.ws.streamProjectBuildLogs(id).subscribe({
              next: msg => {
                if (!this.selected || this.selected.id !== id) return;
                if (msg.type === 'line') {
                  this.buildLog += (msg.data ?? '') + '\n';
                  const line = msg.data ?? '';
                  const legacy = /^Step (\d+)\/(\d+)/.exec(line);
                  const bk = /^#\d+ \[(\d+)\/(\d+)\]/.exec(line);
                  if (legacy) { this.buildStep = +legacy[1]; this.buildTotal = +legacy[2]; }
                  else if (bk) { this.buildStep = +bk[1]; this.buildTotal = +bk[2]; }
                } else if (msg.type === 'done') {
                  this.building = false;
                  this.running = false;
                  const status = msg.status ?? 'idle';
                  this.setSelectedStatus(status as any);
                  if (status === 'failed') {
                    if (msg.port_conflict) {
                      this.portConflictPort = msg.port_conflict;
                      this.portConflictNewPort = String(Number(msg.port_conflict) + 1);
                      this.portConflictBanner = true;
                    } else {
                      this.notify.error('Run failed');
                    }
                  } else {
                    this.notify.success('Project is running');
                    // Build finished and the container is up — surface the run log.
                    if (status === 'running') this.logTab = 'run';
                    this.refreshProject();
                  }
                }
              },
              error: () => {
                this.building = false;
                this.running = false;
                this.setSelectedStatus('failed');
                this.notify.error('Connection lost');
              },
            }),
          );
        },
      }),
    );
  }

  stopProject(): void {
    if (!this.selected) return;
    this.stopping = true;
    this.subs.add(
      this.docker.stopProject(this.selected.id).subscribe({
        next: () => { this.stopping = false; this.setSelectedStatus('stopped'); },
        error: err => { this.stopping = false; this.notify.error('Stop failed: ' + (err.error?.error ?? err.message)); },
      }),
    );
  }

  restartProject(): void {
    if (!this.selected) return;
    this.stopping = true;
    this.subs.add(
      this.docker.restartProject(this.selected.id).subscribe({
        next: () => { this.stopping = false; this.notify.success('Project restarted'); },
        error: err => { this.stopping = false; this.notify.error('Restart failed: ' + (err.error?.error ?? err.message)); },
      }),
    );
  }

  async deleteProject(): Promise<void> {
    const sel = this.selected;
    if (!sel) return;
    const { confirmed, checked } = await this.confirm.confirmWithCheckbox({
      title: `Delete project "${sel.name}"?`,
      message: 'Stops and removes the project\'s containers, networks and files. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      checkboxLabel: 'Also remove the built image and volumes',
      checkboxDefault: true,
    });
    if (!confirmed) return;
    this.startDelete(sel, checked);
  }

  // Kicks off the async teardown and opens the progress modal, streaming each
  // step over the delete WebSocket. `purge` also removes the image and volumes.
  private startDelete(proj: Project, purge: boolean): void {
    this.deleting = true;
    this.deleteDone = false;
    this.deleteError = '';
    this.deleteProjectName = proj.name;
    this.deleteSteps = [];
    const id = proj.id;

    this.subs.add(
      this.docker.deleteProject(id, purge).subscribe({
        next: () => {
          this.subs.add(
            this.ws.streamProjectDeleteProgress(id).subscribe({
              next: ev => this.onDeleteEvent(proj, ev),
              error: () => {
                // Progress stream dropped — the backend teardown still runs.
                // Refresh the list so the row disappears once it finishes.
                this.deleting = false;
                if (this.selected?.id === id) this.selected = null;
                this.loadProjects();
                this.notify.info('Deletion is still running in the background.');
              },
            }),
          );
        },
        error: err => {
          this.deleting = false;
          this.notify.error('Delete failed: ' + (err.error?.error ?? err.message));
        },
      }),
    );
  }

  private onDeleteEvent(proj: Project, ev: DeleteProgressEvent): void {
    switch (ev.type) {
      case 'plan':
        this.deleteSteps = (ev.steps ?? []).map(s => ({ key: s.key, label: s.label, state: 'pending' as const }));
        break;
      case 'step': {
        const i = (ev.index ?? 0) - 1;
        if (i >= 0 && i < this.deleteSteps.length && ev.state) {
          this.deleteSteps[i].state = ev.state;
        }
        break;
      }
      case 'error':
        this.deleteError = ev.data || 'Deletion failed';
        for (const s of this.deleteSteps) { if (s.state === 'running') s.state = 'failed'; }
        break;
      case 'done':
        this.deleteDone = true;
        this.projects = this.projects.filter(p => p.id !== proj.id);
        if (this.selected?.id === proj.id) this.selected = null;
        this.notify.success(`Project "${proj.name}" deleted`);
        // Let the completed checklist linger briefly, then close.
        setTimeout(() => { if (this.deleteDone) this.deleting = false; }, 900);
        break;
    }
  }

  // The modal is only dismissible once the teardown has finished or failed —
  // never mid-flight.
  closeDeleteModal(): void {
    if (this.deleteDone || this.deleteError) this.deleting = false;
  }

  get deleteDoneCount(): number {
    return this.deleteSteps.filter(s => s.state === 'done' || s.state === 'failed').length;
  }

  get deleteProgressPct(): number {
    if (this.deleteSteps.length === 0) return this.deleteDone ? 100 : 5;
    return Math.round(this.deleteDoneCount / this.deleteSteps.length * 100);
  }

  refreshProject(): void {
    if (!this.selected) return;
    this.subs.add(
      this.docker.getProject(this.selected.id).subscribe({
        next: proj => {
          const idx = this.projects.findIndex(p => p.id === proj.id);
          if (idx >= 0) this.projects[idx] = proj;
          if (this.selected?.id === proj.id) {
            this.selected = proj;
            // Sync the rendered logs with the freshly-persisted values. The run
            // log is only written to the DB (never streamed over the WebSocket),
            // so this is what surfaces it once a build/run finishes — without it
            // the Run-log panel stays empty until a full page reload.
            this.buildLog = proj.build_log ?? '';
            this.runLog   = proj.run_log   ?? '';
          }
        },
      }),
    );
  }

  // ── Ports ──────────────────────────────────────────────────────────────────

  parsedPorts(): { host: string; container: string }[] {
    if (!this.selected?.ports) return [];
    return this.selected.ports.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [h, c] = s.split(':');
      return { host: h ?? '', container: c ?? h ?? '' };
    });
  }

  openPort(host: string): void {
    window.open(`http://localhost:${host}`, '_blank');
  }

  openFirstPort(): void {
    if (this.firstPort) this.openPort(this.firstPort);
  }

  togglePortEditor(): void {
    if (!this.portsEditing) {
      this.portRows = this.parsedPorts().map(p => ({ ...p }));
      if (this.portRows.length === 0) this.portRows.push({ host: '', container: '' });
    }
    this.portsEditing = !this.portsEditing;
  }

  openPortEditor(): void {
    this.portConflictBanner = false;
    this.tab = 'overview';
    this.togglePortEditor();
  }

  remapAndRebuild(): void {
    if (!this.selected || !this.portConflictPort || !this.portConflictNewPort) return;
    const id = this.selected.id;
    this.portConflictBanner = false;
    this.subs.add(
      this.docker.overrideProjectPort(id, this.portConflictPort, this.portConflictNewPort).subscribe({
        next: () => this.buildProject(),
        error: err => this.notify.error('Remap failed: ' + (err.error?.error ?? err.message)),
      }),
    );
  }

  addPortRow(): void {
    this.portRows.push({ host: '', container: '' });
  }

  removePortRow(i: number): void {
    this.portRows.splice(i, 1);
  }

  savePorts(): void {
    if (!this.selected) return;
    const ports = this.portRows.filter(r => r.host.trim() && r.container.trim())
      .map(r => `${r.host.trim()}:${r.container.trim()}`).join(', ');
    this.subs.add(
      this.docker.updateProjectPorts(this.selected.id, ports).subscribe({
        next: () => {
          this.selected!.ports = ports;
          this.portsEditing = false;
          this.notify.success('Ports updated');
        },
        error: err => this.notify.error('Failed to update ports: ' + (err.error?.error ?? err.message)),
      }),
    );
  }

  cancelPortEdit(): void {
    this.portsEditing = false;
    this.portRows = [];
  }

  // ── Git / Source ───────────────────────────────────────────────────────────

  loadDeployHook(projectId: number): void {
    this.docker.getDeployHook(projectId).subscribe({
      next: r => { this.deployOnPush = !!r.enabled; },
      error: () => { this.deployOnPush = false; },
    });
  }

  toggleDeployOnPush(): void {
    if (!this.selected) return;
    const id = this.selected.id;
    this.dopLoading = true;
    const obs = this.deployOnPush ? this.docker.disableDeployHook(id) : this.docker.enableDeployHook(id);
    obs.subscribe({
      next: () => {
        this.deployOnPush = !this.deployOnPush;
        this.dopLoading = false;
        this.notify.success(this.deployOnPush ? 'Deploy-on-push enabled' : 'Deploy-on-push disabled');
      },
      error: (e: any) => { this.dopLoading = false; this.notify.error(e?.error?.error || 'Failed to update'); },
    });
  }

  initRepo(): void {
    if (!this.selected) return;
    this.gitLoading = true;
    this.subs.add(
      this.docker.initProjectRepo(this.selected.id).subscribe({
        next: repo => {
          this.linkedRepo = repo;
          this.selected!.repo_id = repo.id;
          this.gitLoading = false;
          this.loadGitStatus();
          this.loadGitBranches();
          this.loadGitHistory();
        },
        error: () => { this.gitLoading = false; },
      }),
    );
  }

  loadLinkedRepo(repoID: number): void {
    this.gitLoading = true;
    this.subs.add(
      this.docker.getGitRepo(repoID).subscribe({
        next: repo => {
          this.linkedRepo = repo;
          this.gitLoading = false;
          this.gitAuthorName  = (repo as any).author_name  ?? '';
          this.gitAuthorEmail = (repo as any).author_email ?? '';
          this.loadGitStatus();
          this.loadGitBranches();
          this.loadGitHistory();
        },
        error: () => { this.gitLoading = false; },
      }),
    );
  }

  loadGitStatus(): void {
    if (!this.linkedRepo) return;
    this.subs.add(
      this.docker.getGitStatus(this.linkedRepo.id).subscribe({
        next: (files: GitFileStatus[]) => { this.gitFiles = files ?? []; },
        error: () => {},
      }),
    );
  }

  loadGitHistory(): void {
    if (!this.linkedRepo) return;
    this.historyLoading = true;
    this.subs.add(
      this.docker.getGitLog(this.linkedRepo.id).subscribe({
        next: commits => { this.commits = commits ?? []; this.historyLoading = false; },
        error: () => { this.historyLoading = false; },
      }),
    );
  }

  loadGitBranches(): void {
    if (!this.linkedRepo) return;
    this.branchesLoading = true;
    this.subs.add(
      this.docker.getGitBranches(this.linkedRepo.id).subscribe({
        next: branches => { this.branches = branches ?? []; this.branchesLoading = false; },
        error: () => { this.branchesLoading = false; },
      }),
    );
  }

  loadDiff(file: GitFileStatus): void {
    if (!this.linkedRepo) return;
    if (this.diffFile?.path === file.path) { this.diffFile = null; this.diffLines = []; return; }
    this.diffFile = file;
    this.diffLines = [];
    this.subs.add(
      this.docker.getGitDiff(this.linkedRepo.id, file.path).subscribe({
        next: result => { this.diffLines = this.parseDiff(result.diff); },
        error: () => {},
      }),
    );
  }

  gitCommit(): void {
    if (!this.linkedRepo || !this.commitMsg.trim()) return;
    this.gitLoading = true;
    this.subs.add(
      this.docker.gitCommit(this.linkedRepo.id, this.commitMsg, this.gitAuthorName, this.gitAuthorEmail).subscribe({
        next: () => {
          this.commitMsg = '';
          this.gitLoading = false;
          this.loadGitStatus();
          this.loadGitHistory();
          this.notify.success('Committed');
        },
        error: err => { this.gitLoading = false; this.notify.error('Commit failed: ' + (err.error?.error ?? err.message)); },
      }),
    );
  }

  saveGitIdentity(): void {
    if (!this.linkedRepo) return;
    this.subs.add(
      this.docker.updateGitRepo(this.linkedRepo.id, {
        author_name: this.gitAuthorName,
        author_email: this.gitAuthorEmail,
      }).subscribe({
        next: repo => {
          this.linkedRepo = repo;
        },
        error: () => {},
      }),
    );
  }

  gitPull(): void {
    if (!this.linkedRepo) return;
    this.gitLoading = true;
    this.subs.add(
      this.docker.gitPull(this.linkedRepo.id).subscribe({
        next: () => { this.gitLoading = false; this.notify.success('Pulled'); this.loadGitStatus(); this.loadGitHistory(); },
        error: err => { this.gitLoading = false; this.notify.error('Pull failed: ' + (err.error?.error ?? err.message)); },
      }),
    );
  }

  gitPush(): void {
    if (!this.linkedRepo) return;
    this.gitLoading = true;
    this.subs.add(
      this.docker.gitPush(this.linkedRepo.id).subscribe({
        next: () => { this.gitLoading = false; this.notify.success('Pushed'); },
        error: err => { this.gitLoading = false; this.notify.error('Push failed: ' + (err.error?.error ?? err.message)); },
      }),
    );
  }

  branchPickerSelect(b: GitBranch): void {
    this.branchPickerOpen = false;
    if (b.current) return;
    this.gitCheckout(b.name);
  }

  gitCheckout(branch: string): void {
    if (!this.linkedRepo) return;
    this.gitLoading = true;
    this.subs.add(
      this.docker.gitCheckout(this.linkedRepo.id, branch).subscribe({
        next: () => {
          this.gitLoading = false;
          this.loadGitBranches();
          this.loadGitStatus();
          if (this.selected) this.selected.branch = branch;
          this.notify.success(`Switched to ${branch}`);
        },
        error: err => { this.gitLoading = false; this.notify.error('Checkout failed: ' + (err.error?.error ?? err.message)); },
      }),
    );
  }

  promptNewBranch(): void {
    this.branchPickerOpen = false;
    this.newBranchName = '';
    this.newBranchOpen = true;
  }

  submitNewBranch(): void {
    const name = this.newBranchName.trim();
    if (!name) return;
    this.newBranchOpen = false;
    this.gitCreateBranch(name);
  }

  gitCreateBranch(name: string): void {
    if (!this.linkedRepo) return;
    this.gitLoading = true;
    this.subs.add(
      this.docker.gitCheckout(this.linkedRepo.id, name, true).subscribe({
        next: () => {
          this.gitLoading = false;
          this.loadGitBranches();
          if (this.selected) this.selected.branch = name;
          this.notify.success(`Created branch ${name}`);
        },
        error: err => { this.gitLoading = false; this.notify.error('Branch failed: ' + (err.error?.error ?? err.message)); },
      }),
    );
  }

  // ── Upload modal ────────────────────────────────────────────────────────────

  openUpload(): void {
    this.showUpload = true;
    this.uploadStep = 1;
  }

  closeUpload(): void {
    this.showUpload = false;
    this.uploadStep = 1;
    this.uploadMode = 'folder';
    this.uploadFile = null;
    this.uploadEntries = [];
    this.uploadFolderName = '';
    this.dragOver = false;
    this.uploading = false;
    this.uploadProgress = 0;
    this.nameError = '';
    this.uploadForm = { name: '', description: '', ports: '' };
    this.uploadPreviewTree = [];
    this.expandedPreviewNodes = new Set();
    this.uploadSkippedCount = 0;
    this.detectedProjectType = 'unknown';
    this.keyFilesFound = [];
    this.previewTreeExpanded = true;
    this.uploadPortRows = [];
    this.detectedPorts = [];
  }

  clearUpload(): void {
    this.uploadFile = null;
    this.uploadEntries = [];
    this.uploadFolderName = '';
    this.uploadPreviewTree = [];
    this.uploadSkippedCount = 0;
    this.detectedProjectType = 'unknown';
    this.keyFilesFound = [];
    this.detectedPorts = [];
    this.uploadForm.name = '';
  }

  advanceUpload(): void {
    const hasContent = this.uploadMode === 'zip' ? !!this.uploadFile : this.uploadEntries.length > 0;
    if (!hasContent) return;
    if (this.uploadPortRows.length === 0) {
      if (this.detectedPorts.length > 0) {
        // Pre-fill with ports parsed from Dockerfile / docker-compose.yml
        this.uploadPortRows = this.detectedPorts.map(p => ({ ...p }));
      } else if (this.uploadForm.ports.trim()) {
        this.uploadPortRows = this.uploadForm.ports.split(',').map(s => s.trim()).filter(Boolean).map(s => {
          const [host, container] = s.split(':');
          return { host: host ?? '', container: container ?? '' };
        });
      }
    }
    this.uploadStep = 2;
  }

  addUploadPortRow(): void { this.uploadPortRows.push({ host: '', container: '' }); }
  removeUploadPortRow(i: number): void { this.uploadPortRows.splice(i, 1); }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver = false;
    if (!event.dataTransfer) return;
    if (this.uploadMode === 'folder') {
      this.processFolderDrop(event.dataTransfer);
    } else {
      const file = event.dataTransfer.files[0];
      if (file?.name.endsWith('.zip')) this.processZipFile(file);
    }
  }

  @ViewChild('folderInput') private folderInputRef!: ElementRef<HTMLInputElement>;

  openFolderPicker(): void {
    this.uploadPending = true;
    this.folderInputRef.nativeElement.click();
    // When the native browser dialog closes (confirm or cancel), window regains
    // focus. Give the change event one tick to fire first; if uploadPending is
    // still true afterwards, the user cancelled — reset to the dropzone.
    const onFocus = () => {
      setTimeout(() => {
        if (this.uploadPending) {
          this.uploadPending = false;
          this.cdr.markForCheck();
        }
      }, 300);
    };
    window.addEventListener('focus', onFocus, { once: true });
  }

  onFolderSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.uploadPending = false;
    if (!input.files?.length) return;
    const files = Array.from(input.files);
    this.uploadProcessing = true;
    setTimeout(() => {
      this.processFolderFiles(files);
      this.uploadProcessing = false;
    });
  }

  onZipSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    this.processZipFile(input.files[0]);
  }

  private processZipFile(file: File): void {
    this.uploadFile = file;
    this.uploadFolderName = file.name;
    this.detectProjectFromName(file.name);
  }

  private processFolderDrop(dt: DataTransfer): void {
    const files: File[] = [];
    const items = dt.items;
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) { /* DataTransferItem path traversal omitted: use input instead */ }
    }
    // Fallback to files
    files.push(...Array.from(dt.files));
    this.uploadProcessing = true;
    setTimeout(() => {
      this.processFolderFiles(files);
      this.uploadProcessing = false;
    });
  }

  private processFolderFiles(files: File[]): void {
    const SKIP_PATTERNS = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'vendor'];
    const MAX_FILES = 2000;

    const filtered = files.filter(f => {
      const parts = (f.webkitRelativePath || f.name).split('/');
      return !parts.some(p => SKIP_PATTERNS.includes(p));
    });

    this.uploadSkippedCount = files.length - filtered.length;
    this.uploadEntries = filtered.slice(0, MAX_FILES);
    if (files.length > MAX_FILES) this.uploadSkippedCount += files.length - MAX_FILES;

    if (this.uploadEntries.length > 0) {
      const firstPath = this.uploadEntries[0].webkitRelativePath || this.uploadEntries[0].name;
      this.uploadFolderName = firstPath.split('/')[0] || 'project';
      if (!this.uploadForm.name) this.uploadForm.name = this.uploadFolderName;
    }

    this.buildUploadPreviewTree();
    this.detectProjectType();
    this.parseExposedPorts();
  }

  private buildUploadPreviewTree(): void {
    const root: Map<string, any> = new Map();
    for (const f of this.uploadEntries.slice(0, 200)) {
      const parts = (f.webkitRelativePath || f.name).split('/').slice(1);
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) { cur.set(part, { name: part, type: 'file' }); }
        else {
          if (!cur.has(part)) cur.set(part, { name: part, type: 'dir', children: new Map() });
          cur = cur.get(part).children;
        }
      }
    }
    this.uploadPreviewTree = this.mapToTree(root);
  }

  private mapToTree(m: Map<string, any>): ProjectFileNode[] {
    const dirs: ProjectFileNode[] = [];
    const files: ProjectFileNode[] = [];
    for (const [, v] of m) {
      if (v.type === 'dir') dirs.push({ name: v.name, type: 'dir', children: this.mapToTree(v.children) });
      else files.push({ name: v.name, type: 'file' });
    }
    return [...dirs.sort((a, b) => a.name.localeCompare(b.name)),
            ...files.sort((a, b) => a.name.localeCompare(b.name))];
  }

  private detectProjectType(): void {
    const names = this.uploadEntries.map(f => (f.webkitRelativePath || f.name).split('/').pop() ?? '');
    const KEY_FILES_LIST = ['Dockerfile','docker-compose.yml','docker-compose.yaml','compose.yml',
                            'package.json','go.mod','cargo.toml','requirements.txt','.env'];
    this.keyFilesFound = KEY_FILES_LIST.filter(k => names.includes(k));

    if (names.includes('docker-compose.yml') || names.includes('docker-compose.yaml') || names.includes('compose.yml')) {
      this.detectedProjectType = 'compose';
    } else if (names.includes('Dockerfile')) {
      this.detectedProjectType = 'dockerfile';
    } else {
      this.detectedProjectType = 'unknown';
    }
  }

  private detectProjectFromName(name: string): void {
    this.detectedProjectType = 'unknown';
    this.keyFilesFound = [];
    this.detectedPorts = [];
  }

  private async parseExposedPorts(): Promise<void> {
    const ports: { host: string; container: string }[] = [];
    const targetNames = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    const relevant = this.uploadEntries.filter(f => {
      const name = (f.webkitRelativePath || f.name).split('/').pop() ?? '';
      return targetNames.includes(name);
    });

    for (const file of relevant) {
      const fileName = (file.webkitRelativePath || file.name).split('/').pop() ?? '';
      const text = await file.text();

      if (fileName === 'Dockerfile') {
        for (const line of text.split('\n')) {
          const m = line.match(/^\s*EXPOSE\s+(.+)/i);
          if (!m) continue;
          for (const part of m[1].trim().split(/\s+/)) {
            const port = part.split('/')[0]; // strip /tcp /udp
            if (/^\d+$/.test(port)) ports.push({ host: port, container: port });
          }
        }
      } else {
        // docker-compose: parse ports: section (short form)
        let inPorts = false;
        for (const line of text.split('\n')) {
          if (/^\s*ports\s*:/.test(line)) { inPorts = true; continue; }
          if (inPorts) {
            if (line.trim() === '' || line.trim().startsWith('#')) continue;
            // Exit block if a non-list key is found
            if (/^\s*\w/.test(line) && !/^\s*-/.test(line)) { inPorts = false; continue; }
            // host:container or ip:host:container
            const mColon = line.match(/^\s*-\s*["']?(?:[\d.]+:)?(\d+):(\d+)["']?\s*(?:#.*)?$/);
            if (mColon) { ports.push({ host: mColon[1], container: mColon[2] }); continue; }
            // bare container port only
            const mSingle = line.match(/^\s*-\s*["']?(\d+)["']?\s*(?:#.*)?$/);
            if (mSingle) { ports.push({ host: mSingle[1], container: mSingle[1] }); }
          }
        }
      }
    }

    // Deduplicate by container port
    const seen = new Set<string>();
    this.detectedPorts = ports.filter(p => {
      if (seen.has(p.container)) return false;
      seen.add(p.container);
      return true;
    });
  }

  submitUpload(): void {
    this.nameError = '';
    const name = this.uploadForm.name.trim();
    if (!name) { this.nameError = 'Name is required'; return; }
    if (!/^[a-zA-Z0-9\-_]+$/.test(name)) { this.nameError = 'Only letters, digits, hyphens and underscores'; return; }

    const ports = this.uploadPortRows.filter(r => r.host.trim() && r.container.trim())
      .map(r => `${r.host.trim()}:${r.container.trim()}`).join(', ');

    const payload = this.uploadMode === 'zip'
      ? this.uploadFile
      : this.uploadEntries.map(f => {
          // webkitRelativePath is "folder-name/sub/file.txt" — strip the leading
          // folder segment so files land at the project root on the server.
          const rel = f.webkitRelativePath || f.name;
          const path = rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : rel;
          return { file: f, path };
        });
    if (!payload || (Array.isArray(payload) && payload.length === 0)) return;

    this.uploading = true;
    this.uploadProgress = 0;

    this.subs.add(
      this.docker.uploadProject(payload as any, name, this.uploadForm.description, ports).subscribe({
        next: (event: any) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.uploadProgress = Math.round(100 * event.loaded / event.total);
          } else if (event.type === HttpEventType.Response) {
            const proj: Project = event.body!;
            this.uploading = false;
            this.projects = [...this.projects, proj].sort((a, b) => a.name.localeCompare(b.name));
            this.closeUpload();
            this.selectProject(proj);
            this.notify.success(`Project "${proj.name}" uploaded (${proj.type})`);
          }
        },
        error: (err: any) => {
          this.uploading = false;
          this.uploadProgress = 0;
          this.nameError = err.error?.error ?? err.message;
        },
      }),
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  setSelectedStatus(status: string): void {
    if (!this.selected) return;
    this.selected = { ...this.selected, status: status as any };
    const idx = this.projects.findIndex(p => p.id === this.selected!.id);
    if (idx >= 0) this.projects[idx] = this.selected;
  }

  relativeTime(dateStr: string): string {
    if (!dateStr) return 'never';
    const d = new Date(dateStr);
    // Guard against Go zero time (year 0001) or invalid dates
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return 'never';
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 5)     return 'just now';
    if (diff < 60)    return diff + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  statusLabel(status: string): string {
    const m: Record<string, string> = {
      idle: 'Idle', running: 'Running', building: 'Building',
      stopped: 'Stopped', failed: 'Failed',
    };
    return m[status] ?? status;
  }

  typeIcon(type: string): string {
    if (type === 'compose')    return 'boxes';
    if (type === 'dockerfile') return 'file-code';
    return 'folder';
  }

  lineCount(log: string): number {
    if (!log) return 0;
    return log.split('\n').filter(l => l.trim()).length;
  }

  downloadLog(): void {
    const content = this.logTab === 'build' ? this.buildLog : this.runLog;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.selected?.name ?? 'project'}-${this.logTab}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  gitStatusClass(f: GitFileStatus): string {
    const s = f.staged !== ' ' ? f.staged : f.unstaged;
    if (s === 'M') return 'M';
    if (s === 'A') return 'A';
    if (s === 'D') return 'D';
    return 'U';
  }

  gitStatusLabel(f: GitFileStatus): string {
    const s = f.staged !== ' ' ? f.staged : f.unstaged;
    return s.trim() || '?';
  }

  private parseDiff(raw: string): DiffLine[] {
    return raw.split('\n').map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) return { type: 'meta' as const, text: line };
      if (line.startsWith('@@'))  return { type: 'hunk'   as const, text: line };
      if (line.startsWith('+'))   return { type: 'add'    as const, text: line };
      if (line.startsWith('-'))   return { type: 'remove' as const, text: line };
      return { type: 'ctx' as const, text: line };
    });
  }
}

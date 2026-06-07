import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { ModalComponent } from '../shared/modal/modal.component';
import { LogViewerComponent } from '../shared/log-viewer/log-viewer.component';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { AuthService } from '../../auth/auth.service';
import { Build, BuildDefinition } from '../../models/docker.models';

@Component({
  selector: 'app-builds',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, ModalComponent, LogViewerComponent],
  templateUrl: './builds.component.html',
  styleUrls: ['./builds.component.scss']
})
export class BuildsComponent implements OnInit, OnDestroy {
  definitions: BuildDefinition[] = [];
  filteredDefs: BuildDefinition[] = [];
  defFilter: 'all' | 'git' | 'inline' = 'all';
  selectedDef: BuildDefinition | null = null;
  defRuns: Build[] = [];
  selectedRun: Build | null = null;
  runsLoading = false;
  detailTab: 'overview' | 'runs' | 'logs' = 'overview';
  loading = false;
  showForm = false;
  form = {
    name: '',
    tag: 'latest',
    sourceType: 'inline' as 'inline' | 'git',
    gitUrl: '',
    gitBranch: 'main',
    dockerfilePath: 'Dockerfile',
    dockerfile: 'FROM alpine\nRUN echo "Hello from Dockyard"',
    pushToRegistry: false,
    registryUrl: 'localhost:5000',
  };

  readonly defCols = '1.8fr 80px 110px 110px 50px 36px';
  readonly runCols = '100px 110px 120px 80px 1fr 36px';

  private pollTimer: any;

  constructor(
    private docker: DockerService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
    public auth: AuthService,
  ) {}

  ngOnInit(): void {
    this.loadDefinitions();
  }

  ngOnDestroy(): void {
    clearInterval(this.pollTimer);
  }

  // ─── Definitions ──────────────────────────────────────────────────────────

  loadDefinitions(): void {
    this.loading = true;
    this.docker.listDefinitions().subscribe({
      next: (defs) => {
        this.definitions = defs;
        this.applyFilter();
        this.loading = false;
        this.managePoll();
      },
      error: (err) => {
        this.notify.error('Failed to load build definitions');
        this.loading = false;
      },
    });
  }

  selectDef(def: BuildDefinition): void {
    this.selectedDef = def;
    this.defRuns = [];
    this.selectedRun = null;
    this.detailTab = 'overview';
    this.loadRuns(def.id);
  }

  closeDef(): void {
    this.selectedDef = null;
    this.defRuns = [];
    this.selectedRun = null;
    clearInterval(this.pollTimer);
  }

  loadRuns(defId: string): void {
    this.runsLoading = true;
    this.docker.listDefinitionRuns(defId).subscribe({
      next: (runs) => {
        this.defRuns = runs;
        this.runsLoading = false;
        this.managePoll();
        // If there is a currently selected run, refresh it
        if (this.selectedRun) {
          const refreshed = runs.find(r => r.id === this.selectedRun!.id);
          if (refreshed) {
            this.selectedRun = refreshed;
          }
        }
      },
      error: () => { this.runsLoading = false; },
    });
  }

  triggerRun(def: BuildDefinition): void {
    this.docker.runDefinition(def.id).subscribe({
      next: () => {
        this.notify.success(`Build started for ${def.name}:${def.tag}`);
        this.loadDefinitions();
        if (this.selectedDef?.id === def.id) {
          this.loadRuns(def.id);
        }
      },
      error: (err) => this.notify.error('Failed to start build'),
    });
  }

  async deleteDef(def: BuildDefinition): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Delete "${def.name}:${def.tag}"?`,
      message: 'Existing run records will be orphaned but preserved.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    this.docker.deleteDefinition(def.id).subscribe({
      next: () => {
        if (this.selectedDef?.id === def.id) this.closeDef();
        this.loadDefinitions();
        this.notify.success(`Definition "${def.name}" deleted`);
      },
      error: (err) => this.notify.error('Failed to delete definition'),
    });
  }

  submitCreateDef(): void {
    if (!this.canSubmit()) return;
    const payload: Partial<BuildDefinition> = {
      name: this.form.name,
      tag: this.form.tag || 'latest',
      source_type: this.form.sourceType,
      git_url: this.form.gitUrl,
      git_branch: this.form.gitBranch,
      dockerfile_path: this.form.dockerfilePath,
      dockerfile: this.form.dockerfile,
      push_to_registry: this.form.pushToRegistry,
      registry_url: this.form.registryUrl,
    };
    this.docker.createDefinition(payload).subscribe({
      next: (def) => {
        this.showForm = false;
        this.form.name = '';
        this.loadDefinitions();
        this.notify.success(`Definition "${def.name}" created`);
      },
      error: (err) => this.notify.error('Failed to create definition'),
    });
  }

  canSubmit(): boolean {
    if (!this.form.name) return false;
    if (this.form.sourceType === 'inline' && !this.form.dockerfile) return false;
    if (this.form.sourceType === 'git' && !this.form.gitUrl) return false;
    return true;
  }

  selectRun(run: Build): void {
    this.docker.getBuild(run.id).subscribe({
      next: (full) => {
        this.selectedRun = full;
        this.detailTab = 'logs';
      },
      error: (err) => this.notify.error('Failed to load run logs'),
    });
  }

  // ─── Filter ───────────────────────────────────────────────────────────────

  setFilter(f: 'all' | 'git' | 'inline'): void {
    this.defFilter = f;
    this.applyFilter();
  }

  applyFilter(): void {
    if (this.defFilter === 'all') {
      this.filteredDefs = this.definitions;
    } else {
      this.filteredDefs = this.definitions.filter(d => d.source_type === this.defFilter);
    }
  }

  countBySource(type: string): number {
    return this.definitions.filter(d => d.source_type === type).length;
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  managePoll(): void {
    const anyRunning = this.defRuns.some(r => r.status === 'running' || r.status === 'queued');
    if (anyRunning) {
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => {
          this.loadDefinitions();
          if (this.selectedDef) this.loadRuns(this.selectedDef.id);
        }, 2000);
      }
    } else {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ─── Cache ────────────────────────────────────────────────────────────────

  clearCache(): void {
    this.docker.clearBuildCache().subscribe({
      next: (_res) => this.notify.success('Build cache cleared'),
      error: (err) => this.notify.error('Failed to clear cache'),
    });
  }

  // ─── Log parsing ─────────────────────────────────────────────────────────

  buildLogLines(raw: string): { n: number; cls: string; text: string }[] {
    return raw.split('\n').map((text, i) => ({ n: i + 1, cls: this.logLineCls(text), text }));
  }

  logLineCls(line: string): string {
    if (/Step \d+\/\d+|^#\d+ \[\d+\/\d+\]/.test(line)) return 'lline-step';
    if (/error|failed|ERROR|FAILED/i.test(line)) return 'lline-err';
    if (/Successfully built|Successfully tagged|DONE/i.test(line)) return 'lline-ok';
    if (/^#\d+ CACHED|Sending build context|From /i.test(line)) return 'lline-dim';
    return '';
  }

  inlineDockerfileLines(): { n: number; cls: string; text: string }[] {
    return this.buildLogLines(this.selectedDef?.dockerfile ?? '');
  }

  // ─── Formatting ───────────────────────────────────────────────────────────

  statusTone(s: string): string {
    switch (s) {
      case 'running': return 'running';
      case 'queued': return 'info';
      case 'succeeded': return 'running';
      case 'failed': return 'danger';
      case 'cancelled': return 'warn';
      default: return 'idle';
    }
  }

  badgeClass(s: string): string {
    return `badge badge-${this.statusTone(s)}`;
  }

  statusLabel(s: string): string {
    switch (s) {
      case 'running': return 'Running';
      case 'queued': return 'Queued';
      case 'succeeded': return 'Success';
      case 'failed': return 'Failed';
      case 'cancelled': return 'Cancelled';
      default: return s;
    }
  }

  formatDuration(ms: number): string {
    if (!ms) return '—';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  timeAgo(isoStr: string): string {
    if (!isoStr) return '—';
    const diff = Date.now() - new Date(isoStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
}

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { ModalComponent } from '../shared/modal/modal.component';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { GitRepo, GitFileStatus, GitCommit, GitBranch } from '../../models/docker.models';

type Tab = 'changes' | 'history' | 'branches';

interface DiffLine {
  type: 'add' | 'remove' | 'hunk' | 'meta' | 'ctx';
  text: string;
}

@Component({
  selector: 'app-source',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, ModalComponent],
  templateUrl: './source.component.html',
  styleUrls: ['./source.component.scss']
})
export class SourceComponent implements OnInit, OnDestroy {
  repos: GitRepo[] = [];
  selectedRepo: GitRepo | null = null;
  loading = false;
  busy = false;

  tab: Tab = 'changes';

  // Changes tab
  files: GitFileStatus[] = [];
  get stagedFiles(): GitFileStatus[] {
    return this.files.filter(f => f.staged !== ' ' && f.staged !== '?');
  }
  get unstagedFiles(): GitFileStatus[] {
    // includes untracked (??) and working-tree modifications
    return this.files.filter(f => f.unstaged !== ' ');
  }

  diffFile: GitFileStatus | null = null;
  diffStaged = false;
  diffLines: DiffLine[] = [];
  diffLoading = false;

  commitMessage = '';
  authorName = '';
  authorEmail = '';
  showAuthorFields = false;
  committing = false;

  // History tab
  commits: GitCommit[] = [];
  historyLoading = false;

  // Branches tab
  branches: GitBranch[] = [];
  get localBranches(): GitBranch[] { return this.branches.filter(b => !b.remote); }
  get remoteBranches(): GitBranch[] { return this.branches.filter(b => b.remote); }
  branchesLoading = false;
  showNewBranch = false;
  newBranchName = '';

  // Add / clone modal
  showAddModal = false;
  addCloneMode = false;
  adding = false;
  addForm = {
    name: '',
    path: '',
    clone_url: '',
    username: '',
    token: '',
    author_name: '',
    author_email: '',
    description: '',
  };

  constructor(
    private docker: DockerService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
  ) {}

  ngOnInit(): void { this.load(); }
  ngOnDestroy(): void {}

  load(): void {
    this.loading = true;
    this.docker.listGitRepos().subscribe({
      next: repos => {
        this.repos = repos;
        if (this.selectedRepo) {
          const updated = repos.find(r => r.id === this.selectedRepo!.id);
          if (updated) this.selectedRepo = updated;
        }
        this.loading = false;
      },
      error: err => {
        this.notify.error('Failed to load repositories');
        this.loading = false;
      },
    });
  }

  selectRepo(repo: GitRepo): void {
    this.selectedRepo = repo;
    this.diffFile = null;
    this.diffLines = [];
    this.commitMessage = '';
    this.authorName = repo.author_name ?? '';
    this.authorEmail = repo.author_email ?? '';
    this.refreshStatus();
    if (this.tab === 'history') this.loadHistory();
    if (this.tab === 'branches') this.loadBranches();
  }

  switchTab(tab: Tab): void {
    this.tab = tab;
    if (!this.selectedRepo) return;
    if (tab === 'changes') this.refreshStatus();
    if (tab === 'history') this.loadHistory();
    if (tab === 'branches') this.loadBranches();
  }

  refreshStatus(): void {
    if (!this.selectedRepo) return;
    this.docker.getGitStatus(this.selectedRepo.id).subscribe({
      next: files => {
        this.files = files;
        if (this.diffFile) {
          const still = files.find(f => f.path === this.diffFile!.path);
          if (!still) { this.diffFile = null; this.diffLines = []; }
        }
      },
      error: () => this.notify.error('Failed to get status'),
    });
  }

  loadHistory(): void {
    if (!this.selectedRepo) return;
    this.historyLoading = true;
    this.docker.getGitLog(this.selectedRepo.id).subscribe({
      next: commits => { this.commits = commits; this.historyLoading = false; },
      error: () => { this.notify.error('Failed to load history'); this.historyLoading = false; },
    });
  }

  loadBranches(): void {
    if (!this.selectedRepo) return;
    this.branchesLoading = true;
    this.docker.getGitBranches(this.selectedRepo.id).subscribe({
      next: branches => { this.branches = branches; this.branchesLoading = false; },
      error: () => { this.notify.error('Failed to load branches'); this.branchesLoading = false; },
    });
  }

  loadDiff(file: GitFileStatus, staged: boolean): void {
    if (!this.selectedRepo) return;
    this.diffFile = file;
    this.diffStaged = staged;
    this.diffLoading = true;
    this.diffLines = [];
    this.docker.getGitDiff(this.selectedRepo.id, file.path, staged).subscribe({
      next: res => {
        this.diffLines = this.parseDiff(res.diff);
        this.diffLoading = false;
      },
      error: () => { this.diffLoading = false; },
    });
  }

  stage(file: GitFileStatus): void {
    if (!this.selectedRepo) return;
    this.docker.stageFiles(this.selectedRepo.id, [file.path]).subscribe({
      next: () => { this.refreshStatus(); this.load(); },
      error: () => this.notify.error('Failed to stage file'),
    });
  }

  unstage(file: GitFileStatus): void {
    if (!this.selectedRepo) return;
    this.docker.unstageFiles(this.selectedRepo.id, [file.path]).subscribe({
      next: () => { this.refreshStatus(); this.load(); },
      error: () => this.notify.error('Failed to unstage file'),
    });
  }

  stageAll(): void {
    if (!this.selectedRepo) return;
    this.docker.stageFiles(this.selectedRepo.id, []).subscribe({
      next: () => { this.refreshStatus(); this.load(); },
      error: () => this.notify.error('Failed to stage all'),
    });
  }

  unstageAll(): void {
    if (!this.selectedRepo) return;
    this.docker.unstageFiles(this.selectedRepo.id, []).subscribe({
      next: () => { this.refreshStatus(); this.load(); },
      error: () => this.notify.error('Failed to unstage all'),
    });
  }

  commit(): void {
    if (!this.selectedRepo || !this.commitMessage.trim() || this.stagedFiles.length === 0) return;
    this.committing = true;
    this.docker.gitCommit(this.selectedRepo.id, this.commitMessage.trim(), this.authorName, this.authorEmail)
      .subscribe({
        next: () => {
          this.notify.success('Committed successfully');
          this.commitMessage = '';
          this.committing = false;
          this.refreshStatus();
          this.load();
          if (this.tab === 'history') this.loadHistory();
        },
        error: err => {
          this.notify.error(err?.error?.error ?? 'Commit failed');
          this.committing = false;
        },
      });
  }

  fetchRepo(): void {
    if (!this.selectedRepo) return;
    this.busy = true;
    this.docker.gitFetch(this.selectedRepo.id).subscribe({
      next: () => { this.notify.success('Fetched'); this.busy = false; this.load(); },
      error: err => { this.notify.error(err?.error?.error ?? 'Fetch failed'); this.busy = false; },
    });
  }

  pullRepo(): void {
    if (!this.selectedRepo) return;
    this.busy = true;
    this.docker.gitPull(this.selectedRepo.id).subscribe({
      next: res => { this.notify.success(res?.output ?? 'Pulled'); this.busy = false; this.load(); this.refreshStatus(); },
      error: err => { this.notify.error(err?.error?.error ?? 'Pull failed'); this.busy = false; },
    });
  }

  pushRepo(): void {
    if (!this.selectedRepo) return;
    this.busy = true;
    this.docker.gitPush(this.selectedRepo.id).subscribe({
      next: res => { this.notify.success(res?.output ?? 'Pushed'); this.busy = false; this.load(); },
      error: err => { this.notify.error(err?.error?.error ?? 'Push failed'); this.busy = false; },
    });
  }

  checkout(branch: string): void {
    if (!this.selectedRepo) return;
    this.docker.gitCheckout(this.selectedRepo.id, branch).subscribe({
      next: () => { this.notify.success(`Switched to ${branch}`); this.loadBranches(); this.load(); },
      error: err => this.notify.error(err?.error?.error ?? 'Checkout failed'),
    });
  }

  createBranch(): void {
    if (!this.selectedRepo || !this.newBranchName.trim()) return;
    this.busy = true;
    this.docker.gitCheckout(this.selectedRepo.id, this.newBranchName.trim(), true).subscribe({
      next: () => {
        this.notify.success(`Created branch ${this.newBranchName}`);
        this.showNewBranch = false;
        this.newBranchName = '';
        this.busy = false;
        this.loadBranches();
        this.load();
      },
      error: err => { this.notify.error(err?.error?.error ?? 'Failed to create branch'); this.busy = false; },
    });
  }

  async removeRepo(): Promise<void> {
    if (!this.selectedRepo) return;
    const managed = this.selectedRepo.path.startsWith('/data/repos');
    const id = this.selectedRepo.id;
    const ok = await this.confirm.confirm({
      title: `Remove "${this.selectedRepo.name}"?`,
      message: managed
		? 'Also delete the managed repository files from disk?'
        : 'This will only remove the repository from tracking. The files on disk will not be deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;

    this.docker.removeGitRepo(id, managed).subscribe({
      next: () => {
        this.notify.success('Repository removed');
        this.selectedRepo = null;
        this.files = [];
        this.load();
      },
      error: () => this.notify.error('Failed to remove repository'),
    });
  }

  openAdd(cloneMode: boolean): void {
    this.addCloneMode = cloneMode;
    this.addForm = { name: '', path: '', clone_url: '', username: '', token: '', author_name: '', author_email: '', description: '' };
    this.showAddModal = true;
  }

  submitAdd(): void {
    this.adding = true;
    const payload: any = {
      name: this.addForm.name,
      description: this.addForm.description,
      author_name: this.addForm.author_name,
      author_email: this.addForm.author_email,
    };
    if (this.addCloneMode) {
      payload.clone_url = this.addForm.clone_url;
      payload.username = this.addForm.username;
      payload.token = this.addForm.token;
    } else {
      payload.path = this.addForm.path;
    }
    this.docker.addGitRepo(payload).subscribe({
      next: repo => {
        this.notify.success(`Repository "${repo.name}" ${this.addCloneMode || this.addForm.path ? 'added' : 'created'}`);
        this.showAddModal = false;
        this.adding = false;
        this.load();
      },
      error: err => {
        this.notify.error(err?.error?.error ?? 'Failed to add repository');
        this.adding = false;
      },
    });
  }

  hasRemote(repo: GitRepo | null): boolean {
    return !!repo?.remote_url?.trim();
  }

  isManagedRepo(repo: GitRepo | null): boolean {
    return !!repo?.path?.startsWith('/data/repos');
  }

  get cloneUrl(): string {
    if (!this.selectedRepo || !this.isManagedRepo(this.selectedRepo)) return '';
    return `${window.location.origin}/git/${this.selectedRepo.name}.git`;
  }

  copyCloneUrl(): void {
    if (!this.cloneUrl) return;
    navigator.clipboard.writeText(this.cloneUrl).then(() => {
      this.notify.success('Clone URL copied');
    }).catch(() => {
      this.notify.error('Failed to copy clone URL');
    });
  }

  // Status badge CSS class helpers
  stagedBadgeClass(status: string): string {
    return 'git-status-badge git-status-' + (status.trim() || 'q');
  }

  unstagedBadgeClass(status: string): string {
    if (status === '?') return 'git-status-badge git-status-q';
    return 'git-status-badge git-status-' + (status.trim() || 'q');
  }

  // Parse unified diff string into colored lines
  private parseDiff(raw: string): DiffLine[] {
    if (!raw) return [];
    return raw.split('\n').map(line => {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
        return { type: 'meta' as const, text: line };
      }
      if (line.startsWith('@@')) return { type: 'hunk' as const, text: line };
      if (line.startsWith('+'))   return { type: 'add' as const, text: line };
      if (line.startsWith('-'))   return { type: 'remove' as const, text: line };
      return { type: 'ctx' as const, text: line };
    });
  }
}

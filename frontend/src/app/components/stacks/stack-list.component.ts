import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DockerService, StackEnvVar, StackDeploy } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { ContextMenuService, ContextMenuItem } from '../../services/context-menu.service';
import { AuthService } from '../../auth/auth.service';
import { StackSummary, StackDetail } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { LongPressDirective } from '../../directives/long-press.directive';
import { ResponsiveService } from '../../services/responsive.service';
import { ModalComponent } from '../shared/modal/modal.component';

@Component({
  selector: 'app-stack-list',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LongPressDirective, ModalComponent],
  templateUrl: './stack-list.component.html',
})
export class StackListComponent implements OnInit {
  stacks: StackSummary[] = [];
  detail: Record<string, StackDetail | null> = {};
  expanded: Record<string, boolean> = {};
  loading = false;
  deploying = false;
  editingName = '';
  showNewStackForm = false;
  stackFilter: 'all' | 'healthy' | 'issues' = 'all';
  form = { name: '', content: '' };

  get filtered(): StackSummary[] {
    if (this.stackFilter === 'healthy') return this.stacks.filter(s => s.status === 'running');
    if (this.stackFilter === 'issues')  return this.stacks.filter(s => s.status !== 'running');
    return this.stacks;
  }

  get healthyCount(): number { return this.stacks.filter(s => s.status === 'running').length; }
  get issueCount(): number   { return this.stacks.filter(s => s.status !== 'running').length; }

  get totalServices(): number   { return this.stacks.reduce((n, s) => n + s.services, 0); }
  get healthyServices(): number { return this.stacks.reduce((n, s) => n + s.running, 0); }

  get toolbarMeta(): string {
    const svc = this.totalServices;
    const ok  = this.healthyServices;
    const bad = svc - ok;
    let s = `${svc} service${svc !== 1 ? 's' : ''} · ${ok} healthy`;
    if (bad > 0) s += ` · ${bad} issue${bad !== 1 ? 's' : ''}`;
    return s;
  }

  constructor(private docker: DockerService, private notify: NotificationService, private confirm: ConfirmDialogService, private ctxMenu: ContextMenuService, public auth: AuthService, public responsive: ResponsiveService) {}

  // ── Context menu ───────────────────────────────────────────────────────────────

  /**
   * Right-click stack menu — mirrors the per-stack action cluster (up / down /
   * restart / edit / env / history / remove) as a single grounded menu.
   */
  stackMenu(e: MouseEvent, s: StackSummary): void {
    const w = this.auth.canWrite();
    const running = s.status === 'running';
    const items: ContextMenuItem[] = [
      { label: 'Open', icon: 'layout-panel-left', accent: true, onSelect: () => { if (!this.expanded[s.name]) this.toggle(s.name); } },
    ];
    if (w) {
      items.push({ type: 'separator' });
      if (running) items.push({ label: 'Stop', icon: 'square', onSelect: () => this.stackAction(s, 'down') });
      else items.push({ label: 'Start', icon: 'play', disabled: !s.has_file, onSelect: () => this.stackAction(s, 'up') });
      items.push({ label: 'Restart', icon: 'rotate-ccw', onSelect: () => this.stackAction(s, 'restart') });
      items.push({ type: 'separator' });
      items.push({ label: 'Edit compose…', icon: 'pencil', onSelect: () => this.editStack(s.name) });
      items.push({ label: 'Environment…', icon: 'sliders-horizontal', onSelect: () => this.openEnv(s) });
    }
    items.push({ label: 'Deploy history', icon: 'history', onSelect: () => this.openHistory(s) });
    if (w) {
      items.push({ type: 'separator' });
      items.push({ label: 'Remove stack', icon: 'trash-2', danger: true, onSelect: () => this.removeStack(s) });
    }
    this.ctxMenu.open(e, items, { header: { name: s.name, meta: this.stackMeta(s), icon: 'boxes' } });
  }

  // Environment-variables editor
  envStack: StackSummary | null = null;
  envVars: StackEnvVar[] = [];
  savingEnv = false;

  openEnv(stack: StackSummary): void {
    this.envStack = stack;
    this.envVars = [];
    this.docker.getStackEnv(stack.name).subscribe({
      next: vars => { this.envVars = vars.length ? vars : [{ key: '', value: '', is_secret: false }]; },
      error: () => { this.envVars = [{ key: '', value: '', is_secret: false }]; },
    });
  }

  addEnvRow(): void { this.envVars.push({ key: '', value: '', is_secret: false }); }
  removeEnvRow(i: number): void { this.envVars.splice(i, 1); }

  saveEnv(): void {
    if (!this.envStack) return;
    const vars = this.envVars.filter(v => v.key.trim());
    this.savingEnv = true;
    this.docker.setStackEnv(this.envStack.name, vars).subscribe({
      next: () => { this.notify.success('Environment saved — redeploy to apply'); this.savingEnv = false; this.envStack = null; },
      error: e => { this.notify.error(e?.error?.error || 'Failed to save environment'); this.savingEnv = false; },
    });
  }

  // Deploy history / rollback
  historyStack: StackSummary | null = null;
  historyDeploys: StackDeploy[] = [];
  rollingBack = false;

  openHistory(stack: StackSummary): void {
    this.historyStack = stack;
    this.historyDeploys = [];
    this.docker.getStackHistory(stack.name).subscribe({
      next: d => { this.historyDeploys = d; },
      error: () => { /* none yet */ },
    });
  }

  async rollback(d: StackDeploy): Promise<void> {
    const stack = this.historyStack;
    if (!stack) return;
    const ok = await this.confirm.confirm({
      title: 'Roll back this stack?',
      message: `Redeploy "${stack.name}" to the snapshot from ${new Date(d.created_at).toLocaleString()}.`,
      confirmLabel: 'Roll back',
    });
    if (!ok) return;
    this.rollingBack = true;
    this.docker.rollbackStack(stack.name, d.id).subscribe({
      next: () => { this.notify.success(`Rolled back ${stack.name}`); this.rollingBack = false; this.historyStack = null; this.load(); },
      error: e => { this.notify.error(e?.error?.error || 'Rollback failed'); this.rollingBack = false; },
    });
  }
  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.docker.listStacks().subscribe({
      next: s => { this.stacks = s; this.loading = false; },
      error: () => { this.notify.error('Failed to load stacks'); this.loading = false; },
    });
  }

  toggle(name: string): void {
    this.expanded[name] = !this.expanded[name];
    if (this.expanded[name] && !this.detail[name]) {
      this.docker.getStack(name).subscribe({
        next: d  => this.detail[name] = d,
        error: () => this.notify.error('Failed to load stack detail'),
      });
    }
  }

  deploy(): void {
    if (!this.form.content) return;
    this.deploying = true;
    const action$ = this.editingName
      ? this.docker.updateStack(this.editingName, this.form.content)
      : this.docker.deployStack(this.form.name, this.form.content);
    action$.subscribe({
      next: () => {
        this.notify.success(this.editingName ? `Updated ${this.editingName}` : `Deployed ${this.form.name}`);
        this.form = { name: '', content: '' };
        this.editingName = '';
        this.deploying = false;
        this.showNewStackForm = false;
        this.load();
      },
      error: () => { this.notify.error('Deploy failed'); this.deploying = false; },
    });
  }

  editStack(name: string): void {
    this.docker.getStack(name).subscribe({
      next: d => {
        this.editingName = name;
        this.form.content = d.compose_content || '';
        this.showNewStackForm = true;
        window.scrollTo(0, 0);
      },
      error: () => this.notify.error('Failed to load stack'),
    });
  }

  cancelEdit(): void {
    this.editingName = '';
    this.form = { name: '', content: '' };
    this.showNewStackForm = false;
  }

  upAll(): void {
    const targets = this.stacks.filter(s => s.has_file);
    if (!targets.length) { this.notify.error('No stacks with a stored compose file'); return; }
    targets.forEach(s => {
      this.docker.stackAction(s.name, 'up').subscribe({
        next: () => this.notify.success(`up — ${s.name}`),
        error: () => this.notify.error(`up failed — ${s.name}`),
      });
    });
    setTimeout(() => this.load(), 1500);
  }

  stackAction(stack: StackSummary, action: 'restart' | 'up' | 'down'): void {
    this.docker.stackAction(stack.name, action).subscribe({
      next: () => { this.notify.success(`${action} — ${stack.name}`); this.load(); },
      error: () => this.notify.error(`${action} failed — ${stack.name}`),
    });
  }

  async removeStack(stack: StackSummary): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove stack "${stack.name}"?`,
      message: 'Containers will be stopped and the compose config deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.docker.removeStack(stack.name, false).subscribe({
      next: () => { this.notify.success(`Removed ${stack.name}`); this.load(); },
      error: () => this.notify.error('Remove failed'),
    });
  }

  onFileSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!this.editingName && !this.form.name) {
      this.form.name = file.name.replace(/\.(yml|yaml)$/i, '').replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
    }
    const reader = new FileReader();
    reader.onload = e => this.form.content = e.target?.result as string;
    reader.readAsText(file);
  }

  // ── Display helpers ──────────────────────────────────────────────────────

  stackMeta(s: StackSummary): string {
    const parts: string[] = [];
    if (s.config_files) parts.push(s.config_files);
    else if (s.has_file) parts.push('docker-compose.yml');
    parts.push(`${s.services} svc`);
    return parts.join(' · ');
  }

  stackBadgeClass(s: StackSummary): string {
    if (s.status === 'running') return 'badge badge-running';
    if (s.status === 'partial') return 'badge badge-warn';
    return 'badge badge-idle';
  }

  svcBadgeClass(status: string): string {
    const s = status.toLowerCase();
    if (s.startsWith('up') || s === 'running') return 'badge badge-running';
    if (s.startsWith('restarting'))            return 'badge badge-warn';
    if (s.startsWith('exited') || s === 'dead') return 'badge badge-danger';
    return 'badge badge-idle';
  }

  /** Shorten Docker status string to a compact label. */
  svcStatus(status: string): string {
    const s = status.toLowerCase();
    if (s.startsWith('up'))         return 'Running';
    if (s.startsWith('restarting')) return 'Restarting';
    if (s.startsWith('exited'))     return 'Exited';
    if (s === 'dead')               return 'Dead';
    if (s === 'created')            return 'Created';
    return status.slice(0, 12);
  }

  /** For compose (non-swarm), each container IS 1 replica. */
  svcReplicas(status: string): string {
    const s = status.toLowerCase();
    const up = s.startsWith('up') || s === 'running' ? 1 : 0;
    return `${up}/1`;
  }
}

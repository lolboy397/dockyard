import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { AuthService } from '../../auth/auth.service';
import { UpdateStatus } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';

interface UpdateStep {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

@Component({
  selector: 'app-system-update',
  standalone: true,
  imports: [CommonModule, IconComponent, StatusDotComponent],
  templateUrl: './system-update.component.html',
  styles: [`
    .upd-layout {
      flex: 1; min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 440px;
      grid-template-rows: minmax(0, 1fr);
    }
    .upd-main { min-height: 0; overflow-y: auto; }

    /* Right rail: updater output (its own scroll, so logs never clip the page). */
    .upd-side {
      min-height: 0; overflow: hidden;
      display: flex; flex-direction: column;
      border-left: 1px solid var(--border);
      background: var(--bg-elevated);
    }
    .upd-side-head {
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 12px 14px; border-bottom: 1px solid var(--border-subtle);
    }
    .upd-side-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px; }

    .upd-log {
      margin: 0; white-space: pre-wrap; word-break: break-word;
      font-family: var(--font-mono); font-size: 11px; line-height: 1.55;
      color: var(--fg-muted);
    }
    .upd-empty { color: var(--fg-subtle); font-size: 12px; line-height: 1.6; padding: 8px 2px; }

    /* ── Updating animation ───────────────────────────────────────────── */
    .upd-progress-card {
      border: 1px solid var(--border); border-radius: var(--r-lg);
      background: var(--bg-raised); padding: 14px; margin-bottom: 14px;
    }
    .upd-progress-top { display: flex; align-items: center; gap: 10px; }
    .upd-orb {
      width: 30px; height: 30px; border-radius: 50%; flex: none; position: relative;
      display: flex; align-items: center; justify-content: center;
    }
    .upd-orb::before {
      content: ''; position: absolute; inset: -3px; border-radius: 50%;
      background: conic-gradient(from 0deg, transparent, var(--accent));
      animation: upd-spin 0.9s linear infinite; -webkit-mask: radial-gradient(circle 11px, transparent 98%, #000 100%);
      mask: radial-gradient(circle 11px, transparent 98%, #000 100%);
    }
    .upd-orb.done::before { animation: none; background: var(--running-400); }
    @keyframes upd-spin { to { transform: rotate(360deg); } }

    .upd-phase { font-size: 13px; font-weight: 600; color: var(--fg); }
    .upd-sub { font-size: 11px; color: var(--fg-subtle); margin-top: 1px; }

    .upd-bar {
      position: relative; height: 4px; margin-top: 12px;
      background: var(--bg-elevated); border-radius: 3px; overflow: hidden;
    }
    .upd-bar::after {
      content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 30%;
      border-radius: 3px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      animation: upd-sweep 1.25s ease-in-out infinite;
    }
    .upd-bar.done::after {
      width: 100%; animation: none;
      background: var(--running-400);
    }
    @keyframes upd-sweep { 0% { left: -30%; } 100% { left: 100%; } }

    @media (max-width: 900px) {
      .upd-layout { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) minmax(0, 44%); }
      .upd-side { border-left: 0; border-top: 1px solid var(--border); }
    }

    /* ── Step checklist ───────────────────────────────────────────────── */
    .upd-steps { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
    .upd-step { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: var(--r-md); }
    .upd-step.st-running { background: var(--accent-soft, rgba(34,211,238,0.08)); }
    .upd-step-ico {
      flex: none; width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
    }
    .upd-step-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-disabled, #475569); }
    .st-running .upd-step-ico { color: var(--accent); }
    .st-done .upd-step-ico { color: var(--running-400); }
    .st-failed .upd-step-ico { color: var(--danger-400, #F87171); }
    .upd-step-label { font-size: 12.5px; color: var(--fg); }
    .st-pending .upd-step-label { color: var(--fg-subtle); }
    .upd-step-detail { font-size: 11px; color: var(--fg-subtle); margin-left: 6px; }

    .upd-reconnect {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; margin-bottom: 12px;
      font-size: 12px; color: var(--fg-muted);
      border: 1px dashed var(--border); border-radius: var(--r-md);
    }

    .upd-raw-toggle {
      display: inline-flex; align-items: center; gap: 5px;
      background: none; border: 0; cursor: pointer; padding: 4px 0;
      font-size: 11px; color: var(--fg-subtle); font-family: var(--font-mono);
    }
    .upd-raw-toggle:hover { color: var(--fg-muted); }
  `],
})
export class SystemUpdateComponent implements OnInit, OnDestroy {
  status: UpdateStatus | null = null;
  loading = false;      // initial / forced check in flight
  applying = false;     // an update is being applied (stack recreating)
  applied = false;      // update finished, page about to reload
  timedOut = false;     // apply didn't complete in time — show updater output
  failed = false;       // updater exited non-zero / a step failed
  loadError = '';       // failed to load the check (e.g. not admin)

  updaterLogs = '';     // output of the most recent updater container
  updaterState = '';    // running / exited (code N)

  steps: UpdateStep[] = [];   // live step checklist parsed from updater output
  disconnected = false;       // last poll failed — the stack is recreating
  showRaw = false;            // reveal the raw updater output below the checklist

  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollStarted = 0;
  private readonly pollTimeoutMs = 6 * 60 * 1000;

  constructor(
    private docker: DockerService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
    public auth: AuthService,
  ) {}

  ngOnInit(): void { this.check(); this.loadUpdaterLogs(); }

  ngOnDestroy(): void { if (this.pollTimer) clearTimeout(this.pollTimer); }

  // Pull the most recent updater container's output + exit state. Used on load
  // (so a prior failed run is visible) and while an update is in progress.
  loadUpdaterLogs(): void {
    this.docker.getUpdateLogs().subscribe({
      next: r => { this.updaterLogs = r.logs || ''; this.updaterState = r.state || ''; },
      error: () => { /* backend may be recreating */ },
    });
  }

  check(force = false): void {
    this.loading = true;
    this.loadError = '';
    this.docker.checkForUpdate(force).subscribe({
      next: s => { this.status = s; this.loading = false; },
      error: e => {
        this.loading = false;
        this.loadError = e?.error?.error || 'Failed to check for updates.';
      },
    });
  }

  get canApply(): boolean {
    return !!this.status?.apply_ready && !!this.status?.update_available
      && this.auth.isAdmin() && !this.applying;
  }

  async apply(): Promise<void> {
    if (!this.canApply) return;
    const ok = await this.confirm.confirm({
      title: 'Update Dockyard now?',
      message: 'New images will be pulled and the stack recreated. Dockyard will briefly go offline and this page will reload automatically when it is back. A backup is taken first if application backups are configured.',
      confirmLabel: 'Update now',
    });
    if (!ok) return;

    this.applying = true;
    this.applied = false;
    this.timedOut = false;
    this.failed = false;
    this.disconnected = false;
    this.updaterLogs = '';
    this.docker.applyUpdate().subscribe({
      next: resp => {
        this.seedSteps(resp?.backup);
        this.notify.info('Update started — pulling images and recreating the stack…');
        this.pollStarted = Date.now();
        this.pollUntilBack();
      },
      error: e => {
        this.applying = false;
        this.notify.error(e?.error?.error || 'Failed to start the update.');
      },
    });
  }

  // Build the initial checklist the moment the update starts: the backup (already
  // taken by the backend) plus a pending step per Dockyard service, in the order
  // the updater processes them (backend last). Live state fills in from the logs.
  private seedSteps(backup?: string): void {
    const steps: UpdateStep[] = [];
    if (backup) steps.push({ key: 'backup', label: 'Backed up current state', state: 'done', detail: backup });
    for (const id of this.serviceIds()) {
      steps.push({ key: 'svc:' + id, label: 'Update ' + id, state: 'pending' });
    }
    this.steps = steps;
  }

  private isBackend(s: string): boolean { return (s || '').toLowerCase().includes('backend'); }

  private serviceIds(): string[] {
    if (!this.status) return [];
    return [...this.status.components]
      .sort((a, b) => (this.isBackend(a.service) ? 1 : 0) - (this.isBackend(b.service) ? 1 : 0))
      .map(c => c.service);
  }

  // Parse the cumulative updater output into the step checklist. The log persists
  // across the backend restart, so re-parsing after a reconnect recovers every
  // step that happened during the gap.
  private parseProgress(logs: string): void {
    const phase: Record<string, string> = {};
    let plan: string[] | null = null;
    let complete = false;
    for (const ln of logs.split('\n')) {
      let m = ln.match(/\[self-update\] plan (.+)/);
      if (m) { plan = m[1].trim().split(/\s+/); continue; }
      m = ln.match(/\[self-update\] step (\S+) (pulling|recreating|done|failed)/);
      if (m) { phase[m[1]] = m[2]; continue; }
      if (ln.includes('[self-update] complete')) complete = true;
    }

    const ids = plan ?? this.serviceIds();
    const svcSteps: UpdateStep[] = ids.map(id => {
      const p = phase[id];
      if (p === 'done') return { key: 'svc:' + id, label: 'Update ' + id, state: 'done' };
      if (p === 'failed') return { key: 'svc:' + id, label: 'Update ' + id, state: 'failed' };
      if (p === 'recreating') return { key: 'svc:' + id, label: 'Update ' + id, state: 'running', detail: 'Recreating container…' };
      if (p === 'pulling') return { key: 'svc:' + id, label: 'Update ' + id, state: 'running', detail: 'Pulling image…' };
      return { key: 'svc:' + id, label: 'Update ' + id, state: 'pending' };
    });
    if (complete) svcSteps.forEach(s => { if (s.state !== 'failed') s.state = 'done'; });

    const backup = this.steps.find(s => s.key === 'backup');
    this.steps = backup ? [backup, ...svcSteps] : svcSteps;
  }

  // Poll until the new build is running (update no longer available). API calls
  // fail while the backend/frontend recreate — those flip `disconnected` and are
  // retried. Once it reports up-to-date, reload to pick up the new frontend.
  private pollUntilBack(): void {
    this.pollTimer = setTimeout(() => {
      if (!this.applying) return;  // already finished (failed/applied) — stop the loop

      // Refresh the updater output each tick to advance the checklist.
      this.docker.getUpdateLogs().subscribe({
        next: r => {
          this.updaterLogs = r.logs || ''; this.updaterState = r.state || '';
          this.parseProgress(this.updaterLogs);
          // The updater exited non-zero (or a step failed) → fail fast instead of
          // waiting out the timeout.
          if (this.applying && (/exited \(code [1-9]/.test(this.updaterState) || this.steps.some(s => s.state === 'failed'))) {
            this.applying = false;
            this.failed = true;
            this.disconnected = false;
            this.steps.forEach(s => { if (s.state === 'running') s.state = 'failed'; });
            this.notify.error('Update failed — see the updater output.');
          }
        },
        error: () => { /* backend recreating */ },
      });

      if (Date.now() - this.pollStarted > this.pollTimeoutMs) {
        this.applying = false;
        this.timedOut = true;
        this.notify.error('Update did not finish in time — see the updater output below.');
        return;
      }
      this.docker.checkForUpdate(true).subscribe({
        next: s => {
          this.status = s;
          this.disconnected = false;
          if (!s.update_available) {
            this.applied = true;
            this.steps.forEach(st => { if (st.state !== 'failed') st.state = 'done'; });
            this.notify.success('Dockyard updated — reloading…');
            setTimeout(() => window.location.reload(), 1500);
          } else {
            this.pollUntilBack();
          }
        },
        error: () => { this.disconnected = true; this.pollUntilBack(); },  // backend still recreating
      });
    }, 5000);
  }

  short(digest?: string): string {
    if (!digest) return '—';
    return digest.replace('sha256:', '').slice(0, 12);
  }

  // Friendly phase label derived from the updater's live output, so the progress
  // card reflects what's actually happening rather than a static spinner.
  get phase(): string {
    if (this.applied) return 'Update complete';
    if (this.disconnected) return 'Reconnecting…';
    const l = (this.updaterLogs || '').toLowerCase();
    if (l.includes('[self-update] complete')) return 'Finishing up…';
    if (l.includes('recreating')) return 'Recreating containers…';
    if (l.includes('pulling')) return 'Pulling new images…';
    if (this.updaterLogs) return 'Starting updater…';
    return 'Preparing update…';
  }
}

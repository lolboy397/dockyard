import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { AuthService } from '../../auth/auth.service';
import { UpdateStatus } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';

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
  `],
})
export class SystemUpdateComponent implements OnInit, OnDestroy {
  status: UpdateStatus | null = null;
  loading = false;      // initial / forced check in flight
  applying = false;     // an update is being applied (stack recreating)
  applied = false;      // update finished, page about to reload
  timedOut = false;     // apply didn't complete in time — show updater output
  loadError = '';       // failed to load the check (e.g. not admin)

  updaterLogs = '';     // output of the most recent updater container
  updaterState = '';    // running / exited (code N)

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
    this.updaterLogs = '';
    this.docker.applyUpdate().subscribe({
      next: () => {
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

  // Poll the check endpoint until the new build is running (update no longer
  // available). API calls fail while the backend/frontend recreate — those are
  // swallowed and retried. Once it reports up-to-date, reload to pick up the new
  // frontend assets.
  private pollUntilBack(): void {
    this.pollTimer = setTimeout(() => {
      // Refresh the updater output each tick so the user sees live progress (and
      // the exact failure if it errors). Swallows failures while the API is down.
      this.loadUpdaterLogs();

      if (Date.now() - this.pollStarted > this.pollTimeoutMs) {
        this.applying = false;
        this.timedOut = true;
        this.notify.error('Update did not finish in time — see the updater output below.');
        return;
      }
      this.docker.checkForUpdate(true).subscribe({
        next: s => {
          this.status = s;
          if (!s.update_available) {
            this.applied = true;
            this.notify.success('Dockyard updated — reloading…');
            setTimeout(() => window.location.reload(), 1500);
          } else {
            this.pollUntilBack();
          }
        },
        error: () => this.pollUntilBack(),  // backend still recreating
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
    const l = (this.updaterLogs || '').toLowerCase();
    if (l.includes('done')) return 'Finishing up…';
    if (l.includes('creating') || l.includes('stopping')) return 'Recreating containers…';
    if (l.includes('pulling')) return 'Pulling new images…';
    if (this.updaterLogs) return 'Starting updater…';
    return 'Preparing update…';
  }
}

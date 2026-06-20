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
})
export class SystemUpdateComponent implements OnInit, OnDestroy {
  status: UpdateStatus | null = null;
  loading = false;      // initial / forced check in flight
  applying = false;     // an update is being applied (stack recreating)
  applied = false;      // update finished, page about to reload
  loadError = '';       // failed to load the check (e.g. not admin)

  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollStarted = 0;
  private readonly pollTimeoutMs = 6 * 60 * 1000;

  constructor(
    private docker: DockerService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
    public auth: AuthService,
  ) {}

  ngOnInit(): void { this.check(); }

  ngOnDestroy(): void { if (this.pollTimer) clearTimeout(this.pollTimer); }

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
    return !!this.status?.compose_ready && !!this.status?.update_available
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
      if (Date.now() - this.pollStarted > this.pollTimeoutMs) {
        this.applying = false;
        this.notify.error('Update is taking longer than expected. Check the updater container logs (dockyard-updater).');
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
}

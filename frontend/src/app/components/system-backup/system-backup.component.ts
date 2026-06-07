import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DockerService, AppBackup, AppBackupSchedule } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { AuthService } from '../../auth/auth.service';
import { IconComponent } from '../shared/icon/icon.component';

@Component({
  selector: 'app-system-backup',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  templateUrl: './system-backup.component.html',
  styleUrls: ['./system-backup.component.scss'],
})
export class SystemBackupComponent implements OnInit {
  loading = true;
  configured = false;
  keyExternal = false;
  backups: AppBackup[] = [];

  schedule: AppBackupSchedule | null = null;
  scheduleForm = { enabled: false, interval_hours: 24, keep: 7 };
  savingSchedule = false;

  creating = false;
  busyName: string | null = null;

  readonly intervals = [
    { value: 6, label: 'Every 6 hours' },
    { value: 12, label: 'Every 12 hours' },
    { value: 24, label: 'Daily' },
    { value: 72, label: 'Every 3 days' },
    { value: 168, label: 'Weekly' },
  ];

  constructor(
    private docker: DockerService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
    public auth: AuthService,
  ) {}

  ngOnInit(): void {
    if (!this.auth.isAdmin()) { this.loading = false; return; }
    this.load();
    this.loadSchedule();
  }

  load(): void {
    this.loading = true;
    this.docker.listAppBackups().subscribe({
      next: r => {
        this.configured = r.configured;
        this.keyExternal = r.key_external;
        this.backups = r.backups || [];
        this.loading = false;
      },
      error: () => { this.loading = false; this.notify.error('Could not load backups'); },
    });
  }

  loadSchedule(): void {
    this.docker.getAppBackupSchedule().subscribe({
      next: r => {
        this.schedule = r.schedule;
        this.scheduleForm = {
          enabled: r.schedule.enabled,
          interval_hours: r.schedule.interval_hours || 24,
          keep: r.schedule.keep || 7,
        };
      },
      error: () => {},
    });
  }

  createNow(): void {
    if (this.creating) return;
    this.creating = true;
    this.notify.info('Creating application backup…');
    this.docker.createAppBackup().subscribe({
      next: () => { this.notify.success('Application backup created'); this.creating = false; this.load(); },
      error: e => { this.notify.error(e?.error?.error || 'Backup failed'); this.creating = false; },
    });
  }

  saveSchedule(): void {
    this.savingSchedule = true;
    this.docker.setAppBackupSchedule({
      enabled: this.scheduleForm.enabled,
      interval_hours: this.scheduleForm.interval_hours,
      keep: this.scheduleForm.keep,
    }).subscribe({
      next: r => {
        this.schedule = r.schedule;
        this.savingSchedule = false;
        this.notify.success(this.scheduleForm.enabled ? 'Automatic backups enabled' : 'Automatic backups disabled');
      },
      error: e => { this.notify.error(e?.error?.error || 'Could not save schedule'); this.savingSchedule = false; },
    });
  }

  download(b: AppBackup): void {
    this.notify.info('Preparing download…');
    this.docker.downloadAppBackup(b.name).subscribe({
      next: resp => { if (resp.body) this.saveBlob(resp.body, b.name); },
      error: () => this.notify.error('Could not download backup'),
    });
  }

  async remove(b: AppBackup): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete backup?',
      message: `The application backup from ${this.formatDate(b.created_at)} will be permanently removed.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    this.busyName = b.name;
    this.docker.deleteAppBackup(b.name).subscribe({
      next: () => { this.notify.info('Backup deleted'); this.busyName = null; this.load(); },
      error: () => { this.notify.error('Delete failed'); this.busyName = null; },
    });
  }

  scheduleLastRun(): string {
    if (!this.schedule?.last_run_at) return 'never';
    return this.formatDate(this.schedule.last_run_at);
  }

  formatBytes(b: number): string {
    if (b == null) return '—';
    if (b <= 0) return '0 B';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  }

  formatDate(s: string): string {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

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
}

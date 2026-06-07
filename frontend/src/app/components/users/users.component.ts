import { Component, HostListener, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { AuthService } from '../../auth/auth.service';
import { AuthUser, Role, ActivityEvent, SessionInfo } from '../../auth/auth.models';
import { AdminService } from '../../services/admin.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import {
  STATUS_LABEL, statusTone, userStatus, initials, timeAgo, monthYear,
  memberCapabilities, activityRail, sessionDevice, sessionLocation,
} from './admin.data';

type MemberFilter = 'all' | 'active' | 'invited' | 'suspended';
type DetailTab = 'profile' | 'access' | 'activity' | 'sessions';

/**
 * Admin · Members — real-data implementation of the member-management design.
 * Lists accounts from /api/v1/users, enriches them with the role catalogue, and
 * drives the tabbed detail panel (profile / capabilities / activity / sessions)
 * and the edit-member modal (role, status, 2FA). Environment-scoped access is
 * intentionally omitted until environments exist.
 */
@Component({
  selector: 'app-users',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  styleUrls: ['./users.component.scss'],
  templateUrl: './users.component.html',
})
export class UsersComponent implements OnInit {
  // exposed helpers
  readonly STATUS_LABEL = STATUS_LABEL;
  readonly statusTone = statusTone;
  readonly userStatus = userStatus;
  readonly initials = initials;
  readonly timeAgo = timeAgo;
  readonly monthYear = monthYear;
  readonly sessionDevice = sessionDevice;
  readonly sessionLocation = sessionLocation;

  readonly memberCols = '32px minmax(0,1fr) 120px 50px 80px 92px 28px';
  readonly tabs: { id: DetailTab; label: string }[] = [
    { id: 'profile',  label: 'Profile' },
    { id: 'access',   label: 'Access' },
    { id: 'activity', label: 'Activity' },
    { id: 'sessions', label: 'Sessions' },
  ];
  readonly filters: { id: MemberFilter; label: string }[] = [
    { id: 'all',       label: 'All' },
    { id: 'active',    label: 'Active' },
    { id: 'invited',   label: 'Invited' },
    { id: 'suspended', label: 'Suspended' },
  ];

  loading = signal(true);
  users = signal<AuthUser[]>([]);
  roles = signal<Role[]>([]);

  selectedId: number | null = null;
  filter: MemberFilter = 'all';
  tab: DetailTab = 'profile';

  activity = signal<ActivityEvent[]>([]);
  activityLoading = signal(false);
  sessions = signal<SessionInfo[]>([]);
  sessionsLoading = signal(false);

  // edit modal
  editing = false;
  saving = false;
  editRole = 'viewer';
  editStatus: 'active' | 'suspended' = 'active';
  editTwofa = false;

  constructor(
    public auth: AuthService,
    private admin: AdminService,
    private notify: NotificationService,
    private confirm: ConfirmDialogService,
  ) {}

  ngOnInit(): void {
    if (this.auth.isAdmin()) this.load();
    else this.loading.set(false);
  }

  load(): void {
    this.loading.set(true);
    this.admin.listRoles().subscribe({
      next: r => this.roles.set(r),
      error: () => {},
    });
    this.auth.listUsers().subscribe({
      next: u => {
        this.users.set(u);
        if (this.selectedId == null && u.length) this.select(u[0].id);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  // ---- role lookup ----
  roleOf(id: string): Role | undefined { return this.roles().find(r => r.id === id); }
  roleName(id: string): string { return this.roleOf(id)?.name || id; }
  roleIcon(id: string): string { return this.roleOf(id)?.icon || 'user'; }
  roleDesc(id: string): string { return this.roleOf(id)?.description || ''; }
  get roleCards(): Role[] { return this.roles(); }

  // ---- derived ----
  get selected(): AuthUser | undefined { return this.users().find(u => u.id === this.selectedId); }
  isYou(u: AuthUser): boolean { return this.auth.user()?.id === u.id; }

  get filtered(): AuthUser[] {
    return this.users().filter(u => this.filter === 'all' || userStatus(u) === this.filter);
  }

  get counts(): Record<MemberFilter, number> {
    const us = this.users();
    return {
      all: us.length,
      active: us.filter(u => userStatus(u) === 'active').length,
      invited: us.filter(u => userStatus(u) === 'invited').length,
      suspended: us.filter(u => userStatus(u) === 'suspended').length,
    };
  }

  // ---- selection / tabs ----
  select(id: number): void {
    this.selectedId = id;
    this.tab = 'profile';
    this.activity.set([]);
    this.sessions.set([]);
  }
  closeDetail(): void { this.selectedId = null; }

  setTab(tab: DetailTab): void {
    this.tab = tab;
    if (tab === 'activity' && this.activity().length === 0) this.loadActivity();
    if (tab === 'sessions' && this.sessions().length === 0) this.loadSessions();
  }

  private loadActivity(): void {
    const u = this.selected;
    if (!u) return;
    this.activityLoading.set(true);
    this.admin.userActivity(u.id).subscribe({
      next: a => { this.activity.set(a); this.activityLoading.set(false); },
      error: () => this.activityLoading.set(false),
    });
  }

  private loadSessions(): void {
    const u = this.selected;
    if (!u) return;
    this.sessionsLoading.set(true);
    this.admin.userSessions(u.id).subscribe({
      next: s => { this.sessions.set(s); this.sessionsLoading.set(false); },
      error: () => this.sessionsLoading.set(false),
    });
  }

  async revokeSessions(): Promise<void> {
    const u = this.selected;
    if (!u) return;
    const mine = this.isYou(u);
    const ok = await this.confirm.confirm({
      title: 'Revoke other sessions?',
      message: mine
        ? 'Signs out every other device and clears stale sessions. Your current session here is kept.'
        : `Signs ${u.full_name || u.username} out of all active sessions.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    this.admin.revokeUserSessions(u.id).subscribe({
      next: r => { this.notify.success(`Revoked ${r.revoked} session${r.revoked === 1 ? '' : 's'}`); this.loadSessions(); },
      error: e => this.notify.error(e?.error?.error || 'Failed to revoke sessions'),
    });
  }

  // ---- capabilities (Access tab) ----
  capabilities(u: AuthUser) { return memberCapabilities(this.roleOf(u.role)); }
  activityRail = activityRail;

  // ---- edit modal ----
  openEdit(): void {
    const u = this.selected;
    if (!u) return;
    this.editRole = u.role;
    this.editStatus = userStatus(u) === 'suspended' ? 'suspended' : 'active';
    this.editTwofa = !!u.two_factor_enabled;
    this.editing = true;
  }
  closeEdit(): void { if (!this.saving) this.editing = false; }
  pickRole(id: string): void { this.editRole = id; }

  get editDirty(): boolean {
    const u = this.selected;
    if (!u) return false;
    return this.editRole !== u.role
      || this.editStatus !== (userStatus(u) === 'suspended' ? 'suspended' : 'active')
      || this.editTwofa !== !!u.two_factor_enabled;
  }

  saveEdit(): void {
    const u = this.selected;
    if (!u || !this.editDirty || this.saving) return;
    this.saving = true;
    this.auth.updateUser(u.id, { role: this.editRole, status: this.editStatus, twoFactor: this.editTwofa }).subscribe({
      next: updated => {
        this.users.update(list => list.map(x => (x.id === updated.id ? updated : x)));
        this.saving = false;
        this.editing = false;
        this.notify.success(`Updated @${u.username}`);
        this.admin.listRoles().subscribe({ next: r => this.roles.set(r) }); // refresh member counts
      },
      error: e => { this.saving = false; this.notify.error(e?.error?.error || 'Update failed'); },
    });
  }

  async remove(): Promise<void> {
    const u = this.selected;
    if (!u) return;
    const ok = await this.confirm.confirm({
      title: `Remove @${u.username}?`,
      message: `${u.full_name || u.username} will be permanently removed from the organization.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.auth.deleteUser(u.id).subscribe({
      next: () => {
        this.notify.success(`Removed @${u.username}`);
        this.editing = false;
        this.selectedId = null;
        this.load();
      },
      error: e => this.notify.error(e?.error?.error || 'Remove failed'),
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.editing) this.closeEdit(); }
}

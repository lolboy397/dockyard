import { Component, HostListener, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { AuthService } from '../../auth/auth.service';
import { AdminService } from '../../services/admin.service';
import { NotificationService } from '../../services/notification.service';
import { ResponsiveService } from '../../services/responsive.service';
import { Role, RoleDetail, CapabilityCatalogue, AuthUser } from '../../auth/auth.models';
import { capMeta, initials, CapStateMeta } from '../users/admin.data';

type RoleFilter = 'all' | 'system' | 'custom';

/**
 * Admin · Roles — real-data implementation of the role-management design. Lists
 * the role catalogue from /api/v1/roles, shows a role-detail panel (capability
 * matrix + assigned members) and the create-custom-role modal. Environment
 * access is intentionally omitted until environments exist.
 */
@Component({
  selector: 'app-roles',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  styleUrls: ['./roles.component.scss'],
  templateUrl: './roles.component.html',
})
export class RolesComponent implements OnInit {
  readonly initials = initials;
  readonly capMeta = capMeta;

  readonly roleCols = 'minmax(0,1.7fr) 90px minmax(0,1fr) 30px';
  readonly filters: { id: RoleFilter; label: string }[] = [
    { id: 'all',    label: 'All' },
    { id: 'system', label: 'System' },
    { id: 'custom', label: 'Custom' },
  ];
  readonly CR_ICONS = ['shield-check', 'siren', 'wrench', 'rocket', 'terminal', 'bell-ring', 'eye', 'key-round'];

  loading = signal(true);
  roles = signal<Role[]>([]);
  catalogue = signal<CapabilityCatalogue | null>(null);

  selectedId: string | null = null;
  detail = signal<RoleDetail | null>(null);
  detailLoading = signal(false);
  filter: RoleFilter = 'all';

  // create modal
  creating = false;
  saving = false;
  crName = '';
  crDesc = '';
  crIcon = 'shield-check';
  crBase = 'none';
  crCaps: Record<string, string> = {};

  constructor(
    public auth: AuthService,
    private admin: AdminService,
    private notify: NotificationService,
    public responsive: ResponsiveService,
  ) {}

  ngOnInit(): void {
    if (this.auth.isAdmin()) this.load();
    else this.loading.set(false);
  }

  load(): void {
    this.loading.set(true);
    this.admin.getCapabilities().subscribe({ next: c => this.catalogue.set(c), error: () => {} });
    this.admin.listRoles().subscribe({
      next: r => {
        this.roles.set(r);
        if (this.selectedId == null && r.length) this.select(r[0].id);
        else if (this.selectedId) this.loadDetail(this.selectedId);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  // ---- list ----
  get filtered(): Role[] {
    return this.roles().filter(r => this.filter === 'all' || r.type === this.filter);
  }
  get counts(): Record<RoleFilter, number> {
    const rs = this.roles();
    return {
      all: rs.length,
      system: rs.filter(r => r.type === 'system').length,
      custom: rs.filter(r => r.type === 'custom').length,
    };
  }

  select(id: string): void {
    this.selectedId = id;
    this.loadDetail(id);
  }
  loadDetail(id: string): void {
    this.detailLoading.set(true);
    this.detail.set(null);
    this.admin.getRole(id).subscribe({
      next: d => { this.detail.set(d); this.detailLoading.set(false); },
      error: () => this.detailLoading.set(false),
    });
  }
  closeDetail(): void { this.selectedId = null; this.detail.set(null); }

  // ---- detail helpers ----
  capState(role: RoleDetail | null, key: string): CapStateMeta {
    return capMeta(role?.capabilities?.[key]);
  }
  members(role: RoleDetail | null): AuthUser[] { return role?.member_list || []; }

  // ---- create modal ----
  private blankCaps(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const g of this.catalogue()?.groups || []) {
      for (const row of g.rows) out[row.key] = 'none';
    }
    return out;
  }
  openCreate(): void {
    this.crName = '';
    this.crDesc = '';
    this.crIcon = 'shield-check';
    this.crBase = 'none';
    this.crCaps = this.blankCaps();
    this.creating = true;
  }
  closeCreate(): void { if (!this.saving) this.creating = false; }

  pickBase(id: string): void {
    this.crBase = id;
    if (id === 'none') { this.crCaps = this.blankCaps(); return; }
    const base = this.roles().find(r => r.id === id);
    this.crCaps = base ? { ...this.blankCaps(), ...base.capabilities } : this.blankCaps();
  }

  setCap(key: string, value: string): void { this.crCaps = { ...this.crCaps, [key]: value }; }

  /** System roles offered as "start from" templates. */
  get templates(): Role[] { return this.roles().filter(r => r.type === 'system' && r.id !== 'owner'); }

  get crValid(): boolean { return this.crName.trim().length > 0; }

  createRole(): void {
    if (!this.crValid || this.saving) return;
    this.saving = true;
    this.admin.createRole({
      name: this.crName.trim(),
      description: this.crDesc.trim(),
      icon: this.crIcon,
      capabilities: this.crCaps,
    }).subscribe({
      next: role => {
        this.saving = false;
        this.creating = false;
        this.filter = 'all';
        this.notify.success(`Created role “${role.name}”`);
        this.selectedId = role.id;
        this.load();
      },
      error: e => { this.saving = false; this.notify.error(e?.error?.error || 'Failed to create role'); },
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void { if (this.creating) this.closeCreate(); }
}

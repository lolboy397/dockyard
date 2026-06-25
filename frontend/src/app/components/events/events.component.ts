import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { DockerService } from '../../services/docker.service';
import { RealtimeService } from '../../services/realtime.service';
import { NotificationService } from '../../services/notification.service';
import { ContextMenuService, ContextMenuItem } from '../../services/context-menu.service';
import { AuthService } from '../../auth/auth.service';
import { AppEvent, EventFilter } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';
import { LongPressDirective } from '../../directives/long-press.directive';

@Component({
  selector: 'app-events',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, LongPressDirective],
  templateUrl: './events.component.html',
  styleUrls: ['./events.component.scss'],
})
export class EventsComponent implements OnInit, OnDestroy {
  events: AppEvent[] = [];
  filtered: AppEvent[] = [];
  live = true;
  q = '';
  eventFilter: 'all' | 'container' | 'image' | 'project' | 'network' | 'error' = 'all';

  // ── Global mute rules ───────────────────────────────────────────────────────
  rules: EventFilter[] = [];
  mutedCount = 0;       // total events hidden by the active rules
  showMuted = false;    // reveal muted events (greyed) instead of hiding them
  showRules = false;    // filter-management panel open
  newName = '';         // add-rule form: object-name pattern
  newKind = '';         // add-rule form: event kind

  private pollSub?: Subscription;

  // Phone: stacked cards instead of the 7-column row grid.
  isMobile = false;
  private mqlMobile = matchMedia('(max-width: 820px)');
  private mqlListener = (e: MediaQueryListEvent): void => { this.isMobile = e.matches; };

  get displayed(): AppEvent[] {
    return this.filtered.slice(0, 200);
  }

  get isAdmin(): boolean { return this.auth.isAdmin(); }

  constructor(
    private docker: DockerService,
    private realtime: RealtimeService,
    private notify: NotificationService,
    private menu: ContextMenuService,
    private auth: AuthService,
  ) {}

  ngOnInit(): void {
    this.isMobile = this.mqlMobile.matches;
    this.mqlMobile.addEventListener('change', this.mqlListener);
    this.loadRules();
    this.load();
    this.startPoll();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
    this.mqlMobile.removeEventListener('change', this.mqlListener);
  }

  load(): void {
    this.docker.getEventsWithMeta(undefined, this.showMuted).subscribe({
      next: res => { this.events = res.events; this.mutedCount = res.muted; this.filter(); },
      error: () => { /* silent on refresh */ },
    });
  }

  loadRules(): void {
    this.docker.getEventFilters().subscribe({
      next: rs => { this.rules = rs; },
      error: () => { /* non-fatal */ },
    });
  }

  startPoll(): void {
    // Reload the audit feed whenever any Docker resource changes (+ resync on
    // reconnect / refocus), instead of a fixed 10s poll.
    this.pollSub = this.realtime.changes().subscribe(() => { if (this.live) this.load(); });
  }

  toggleLive(): void {
    this.live = !this.live;
    if (this.live) this.load();
  }

  toggleShowMuted(): void {
    this.showMuted = !this.showMuted;
    this.load();
  }

  setFilter(f: typeof this.eventFilter): void {
    this.eventFilter = f;
    this.filter();
  }

  countByType(type: string): number {
    if (type === 'error') return this.events.filter(e => this.eventTone(e) === 'danger').length;
    return this.events.filter(e => e.object_type === type).length;
  }

  filter(): void {
    let base = this.events;
    if (this.eventFilter === 'error') {
      base = base.filter(e => this.eventTone(e) === 'danger');
    } else if (this.eventFilter !== 'all') {
      base = base.filter(e => e.object_type === this.eventFilter);
    }
    const s = this.q.toLowerCase();
    this.filtered = s
      ? base.filter(e =>
          e.message.toLowerCase().includes(s) ||
          e.kind.toLowerCase().includes(s) ||
          (e.object_name || '').toLowerCase().includes(s) ||
          (e.image || '').toLowerCase().includes(s))
      : [...base];
  }

  // ── Muting ──────────────────────────────────────────────────────────────────

  // Mirrors the backend rule semantics so muted rows can be greyed client-side
  // when "show muted" is on.
  isMuted(e: AppEvent): boolean {
    return this.rules.some(f => f.enabled &&
      (!f.object_name || (e.object_name || '').toLowerCase().includes(f.object_name.toLowerCase())) &&
      (!f.kind || e.kind === f.kind));
  }

  // Right-click an event → quick mute options (admin only).
  openEventMenu(ev: MouseEvent, e: AppEvent): void {
    if (!this.isAdmin) return;
    const name = e.object_name || '';
    const kindLabel = this.formatKind(e.kind);
    const items: ContextMenuItem[] = [{ type: 'label', label: 'Mute events like this' }];
    if (name) {
      items.push(
        { label: `Mute all from “${name}”`, icon: 'bell-off', onSelect: () => this.addRule(name, '') },
        { label: `Mute “${kindLabel}” from “${name}”`, icon: 'bell-off', onSelect: () => this.addRule(name, e.kind) },
      );
    }
    items.push({ label: `Mute all “${kindLabel}” events`, icon: 'bell-off', onSelect: () => this.addRule('', e.kind) });
    items.push({ type: 'separator' });
    items.push({ label: 'Manage filters…', icon: 'filter', onSelect: () => { this.showRules = true; } });
    this.menu.open(ev, items, { header: { name: kindLabel, meta: name || e.object_type, icon: 'bell-off' } });
  }

  addRule(objectName: string, kind: string): void {
    this.docker.createEventFilter(objectName, kind).subscribe({
      next: () => {
        this.notify.success('Filter added');
        this.loadRules();
        this.load();
      },
      error: err => this.notify.error('Failed to add filter: ' + (err.error?.error ?? err.message)),
    });
  }

  addRuleFromForm(): void {
    if (!this.newName.trim() && !this.newKind.trim()) {
      this.notify.error('Set a name pattern, a kind, or both');
      return;
    }
    this.docker.createEventFilter(this.newName.trim(), this.newKind.trim()).subscribe({
      next: () => {
        this.newName = ''; this.newKind = '';
        this.notify.success('Filter added');
        this.loadRules();
        this.load();
      },
      error: err => this.notify.error('Failed to add filter: ' + (err.error?.error ?? err.message)),
    });
  }

  toggleRule(f: EventFilter): void {
    this.docker.setEventFilterEnabled(f.id, !f.enabled).subscribe({
      next: () => { f.enabled = !f.enabled; this.load(); },
      error: err => this.notify.error('Failed to update filter: ' + (err.error?.error ?? err.message)),
    });
  }

  removeRule(f: EventFilter): void {
    this.docker.deleteEventFilter(f.id).subscribe({
      next: () => {
        this.rules = this.rules.filter(r => r.id !== f.id);
        this.notify.success('Filter removed');
        this.load();
      },
      error: err => this.notify.error('Failed to remove filter: ' + (err.error?.error ?? err.message)),
    });
  }

  ruleLabel(f: EventFilter): string {
    const kind = f.kind ? this.formatKind(f.kind) : '';
    if (f.object_name && f.kind) return `${kind} · ${f.object_name}`;
    if (f.object_name) return `all · ${f.object_name}`;
    return `${kind} · any`;
  }

  formatKind(kind: string): string {
    return kind.replace(/_/g, ' ');
  }

  eventTone(e: AppEvent): string {
    const k = e.kind.toLowerCase();
    if (/die|kill|oom|destroy|fail|error/.test(k)) return 'danger';
    if (/^start|_start$|pull|build_success|project_start|update_success|build_success/.test(k)) return 'running';
    if (/restart|pause|update_available|_stop$|project_stop/.test(k)) return 'warn';
    if (/create|connect|attach|mount|login|commit|tag|push/.test(k)) return 'info';
    return 'idle';
  }

  eventIcon(e: AppEvent): string {
    const k = e.kind.toLowerCase();
    if (/die|kill/.test(k)) return 'square';
    if (/oom/.test(k)) return 'alert-triangle';
    if (/destroy|remove|delete/.test(k)) return 'trash-2';
    if (/fail|error/.test(k)) return 'x-circle';
    if (/update_available/.test(k)) return 'arrow-up-circle';
    if (/update_success/.test(k)) return 'check-circle';
    if (/restart/.test(k)) return 'rotate-ccw';
    if (/pause/.test(k)) return 'pause';
    if (/build/.test(k)) return 'hammer';
    if (/pull/.test(k)) return 'download';
    if (/push/.test(k)) return 'upload';
    if (/start/.test(k)) return 'play';
    if (/stop/.test(k)) return 'square';
    if (/create/.test(k)) return 'plus';
    if (/network/.test(e.object_type)) return 'network';
    if (/volume/.test(e.object_type)) return 'database';
    if (/connect/.test(k)) return 'link';
    return 'activity';
  }
}

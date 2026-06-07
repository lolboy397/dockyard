import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { DockerService } from '../../services/docker.service';
import { RealtimeService } from '../../services/realtime.service';
import { NotificationService } from '../../services/notification.service';
import { AppEvent } from '../../models/docker.models';
import { IconComponent } from '../shared/icon/icon.component';

@Component({
  selector: 'app-events',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  templateUrl: './events.component.html',
  styleUrls: ['./events.component.scss'],
})
export class EventsComponent implements OnInit, OnDestroy {
  events: AppEvent[] = [];
  filtered: AppEvent[] = [];
  live = true;
  q = '';
  eventFilter: 'all' | 'container' | 'image' | 'project' | 'network' | 'error' = 'all';
  private pollSub?: Subscription;

  get displayed(): AppEvent[] {
    return this.filtered.slice(0, 200);
  }

  constructor(private docker: DockerService, private realtime: RealtimeService, private notify: NotificationService) {}

  ngOnInit(): void {
    this.load();
    this.startPoll();
  }

  ngOnDestroy(): void { this.pollSub?.unsubscribe(); }

  load(): void {
    this.docker.getEvents().subscribe({
      next: evs => { this.events = evs; this.filter(); },
      error: () => { /* silent on refresh */ },
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


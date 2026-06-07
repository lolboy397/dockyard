import { Component, Input } from '@angular/core';

type DotTone = 'running' | 'warn' | 'danger' | 'info' | 'idle' | 'accent';

const TONE_COLORS: Record<DotTone, string> = {
  running: 'var(--running-400)',
  warn:    'var(--warn-400)',
  danger:  'var(--danger-400)',
  info:    'var(--info-400)',
  idle:    'var(--idle-400)',
  accent:  'var(--accent)',
};

/**
 * Status dot — colored circle indicating health/state.
 * Usage: <dy-dot tone="running"></dy-dot>
 */
@Component({
  selector: 'dy-dot',
  standalone: true,
  templateUrl: './status-dot.component.html',
})
export class StatusDotComponent {
  @Input() tone: DotTone = 'idle';
  @Input() size = 6;

  get color(): string {
    return TONE_COLORS[this.tone] ?? 'var(--idle-400)';
  }
}

/** Map a Docker container status string to a dot tone. */
export function statusTone(status: string): DotTone {
  const s = (status || '').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'paused' || s === 'restarting') return 'warn';
  if (s === 'exited' || s === 'dead' || s === 'removing') return 'danger';
  if (s === 'created') return 'info';
  return 'idle';
}

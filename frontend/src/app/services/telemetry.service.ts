import { Injectable, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';

interface DiagReport {
  level: 'error' | 'warn' | 'info';
  message: string;
  component?: string;
  stack?: string;
  request_id?: string;
  release?: string;
  url?: string;
  context?: Record<string, unknown>;
}

/**
 * Front-end half of "Dockyard Insights": captures uncaught JS errors, unhandled
 * rejections and network failures and ships them to POST /api/v1/diag/events,
 * where they land in the same store as backend 5xx/panics (correlated by
 * X-Request-Id). Hand-written (no SDK) to keep the bundle near-nil. Reports are
 * deduped, queued, and flushed in a batch via fetch keepalive (survives unload).
 */
@Injectable({ providedIn: 'root' })
export class TelemetryService {
  private auth = inject(AuthService);

  private queue: DiagReport[] = [];
  private readonly seen = new Map<string, number>(); // dedup key → last-sent epoch ms
  private readonly sessionId = Math.random().toString(36).slice(2, 10);
  private readonly endpoint = '/api/v1/diag/events';
  private readonly maxQueue = 25;
  private readonly dedupMs = 10_000;
  private started = false;

  /** Wire global listeners once (called from app bootstrap). */
  start(): void {
    if (this.started) return;
    this.started = true;

    window.addEventListener('error', (e: ErrorEvent) => {
      const err = e.error;
      this.report('error', err?.message || e.message || 'Uncaught error', {
        stack: err?.stack,
        component: this.routeName(),
        context: { source: e.filename, line: e.lineno, col: e.colno },
      });
    });
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      const r = e.reason;
      this.report('error', (r?.message || String(r) || 'Unhandled promise rejection'), {
        stack: r?.stack,
        component: this.routeName(),
        context: { kind: 'unhandledrejection' },
      });
    });
    // Flush on page hide (best chance to deliver before unload) + periodically.
    addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); });
    addEventListener('pagehide', () => this.flush());
    setInterval(() => this.flush(), 15_000);
  }

  /** Record one diagnostic. Deduped within a short window; dropped if signed out
   *  (the endpoint needs auth) or empty. Never throws. */
  report(level: DiagReport['level'], message: string, opts?: Partial<DiagReport>): void {
    try {
      if (!this.auth.authed()) return;
      const msg = (message || '').trim();
      if (!msg) return;
      const top = (opts?.stack || '').split('\n')[1] || '';
      const key = level + '|' + (opts?.component || '') + '|' + msg.split('\n')[0] + '|' + top;
      const now = Date.now();
      const last = this.seen.get(key);
      if (last && now - last < this.dedupMs) return;
      this.seen.set(key, now);
      if (this.seen.size > 200) this.seen.clear();

      this.queue.push({
        level,
        message: msg.slice(0, 2000),
        component: opts?.component || this.routeName(),
        stack: opts?.stack?.slice(0, 8000),
        request_id: opts?.request_id,
        release: this.auth.status()?.app_version || '',
        url: location.pathname,
        context: {
          ...(opts?.context || {}),
          session: this.sessionId,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          online: navigator.onLine,
          user: this.auth.user()?.username,
          role: this.auth.user()?.role,
        },
      });
      if (this.queue.length >= this.maxQueue) this.flush();
    } catch { /* telemetry must never break the app */ }
  }

  /** Ship the queued reports in one keepalive POST (so it survives page unload). */
  private flush(): void {
    if (!this.queue.length || !this.auth.authed()) return;
    const batch = this.queue.splice(0, this.queue.length);
    const token = this.auth.token;
    try {
      void fetch(this.endpoint, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(batch),
      }).catch(() => { /* swallow — never surface telemetry failures */ });
    } catch { /* ignore */ }
  }

  private routeName(): string {
    return location.pathname.replace(/^\/+/, '') || 'app';
  }
}

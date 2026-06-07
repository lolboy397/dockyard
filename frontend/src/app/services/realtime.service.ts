import { Injectable } from '@angular/core';
import { Observable, Subject, merge } from 'rxjs';
import { debounceTime, filter, map } from 'rxjs/operators';
import { AuthService } from '../auth/auth.service';

/** A Docker daemon event as delivered over /ws/events (fields are capitalised by
 *  the Go SDK's events.Message; `id`/`status` are the legacy lowercase ones). */
export interface DockerEvent {
  Type?: string;   // container | image | volume | network | daemon | …
  Action?: string; // start | stop | die | destroy | create | pull | …
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  id?: string;
  status?: string;
}

/**
 * RealtimeService — one shared WebSocket to /ws/events (the live Docker daemon
 * event firehose) that replaces per-page polling. Pages call `changes(types)`
 * to be told (debounced) when a resource changed, and refetch via REST.
 *
 * Safety net: it also emits a resync tick on every (re)connect and on tab
 * refocus, so a dropped socket (engine blip, laptop sleep) — during which events
 * are missed — can never leave the UI permanently stale.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  // Match the page protocol: wss:// over HTTPS, ws:// otherwise.
  private wsBase = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

  private event$ = new Subject<DockerEvent>();
  private resync$ = new Subject<void>();

  private started = false;
  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;

  constructor(private auth: AuthService) {}

  /** Open the single shared events socket (idempotent — safe to call anywhere). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.open();
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private onFocus = () => this.resync$.next();
  private onVisible = () => { if (document.visibilityState === 'visible') this.resync$.next(); };

  private open(): void {
    const token = this.auth.token;
    if (!token) { this.scheduleReconnect(5000); return; } // not authenticated yet
    const ws = new WebSocket(`${this.wsBase}/ws/events?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.resync$.next(); };
    ws.onmessage = (e) => {
      try { this.event$.next(JSON.parse(e.data) as DockerEvent); } catch { /* ignore malformed frame */ }
    };
    ws.onerror = () => { /* the close handler schedules the reconnect */ };
    ws.onclose = () => {
      this.attempt++;
      this.scheduleReconnect(Math.min(1000 * 2 ** this.attempt, 15000));
    };
  }

  private scheduleReconnect(delay: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /**
   * Emits (debounced) whenever a resource whose Type is in `types` changes, and
   * once on every (re)connect / tab refocus. Pass an empty `types` to react to
   * any event. Debouncing collapses bursts (e.g. a `compose up` firing dozens of
   * events) into a single refetch.
   */
  changes(types: string[] = [], debounceMs = 250): Observable<void> {
    this.start();
    const matched = this.event$.pipe(
      filter(e => types.length === 0 || (!!e.Type && types.includes(e.Type))),
      map(() => undefined as void),
    );
    return merge(matched, this.resync$).pipe(debounceTime(debounceMs));
  }
}

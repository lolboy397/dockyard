import { Injectable } from '@angular/core';
import { Observable, Subject, BehaviorSubject } from 'rxjs';
import { AuthService } from '../auth/auth.service';

export interface WsMessage {
  data: string;
}

export interface BuildLogEvent {
  type: 'line' | 'done' | 'error';
  data?: string;
  status?: string;
  port_conflict?: string;
}

export interface DeleteStep {
  key: string;
  label: string;
}

export interface DeleteProgressEvent {
  type: 'plan' | 'step' | 'done' | 'error';
  steps?: DeleteStep[];
  index?: number;
  total?: number;
  key?: string;
  state?: 'running' | 'done' | 'failed';
  data?: string;
}

export interface ContainerStatSummary {
  id: string;
  name: string;
  cpu: number;
  mem: number;
  mem_limit: number;
  net_rx: number;   // cumulative received bytes (delta → throughput)
  net_tx: number;   // cumulative transmitted bytes
}

/**
 * One multiplexed frame, tagged with the container it came from. `type` is
 * 'log' for normal output, 'error' for a stream/subscription failure, and
 * 'status' for connection notices (e.g. dropped lines). `ts` is Docker's
 * RFC3339 timestamp for the line (absent on status frames or untimestamped
 * output), so the client can show the real log time, not its receive time.
 */
export interface MultiLogFrame {
  type?: 'log' | 'error' | 'status' | 'counts';
  id?: string;
  ts?: string;
  data: string;
  /** Present on 'counts' frames: a per-container cumulative tally by level, sent
   *  so the level pills stay accurate when server-side filtering drops lines. */
  counts?: { info: number; warn: number; err: number };
}

/** Live connection state of the multiplexed socket, so the UI can be honest about
 *  whether the "live" claim actually holds (vs reconnecting/offline). */
export type MultiLogState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Controller for a single multiplexed log WebSocket (see streamMultiLogs). */
export interface MultiLogStream {
  frames$: Observable<MultiLogFrame>;
  /** Emits the current connection state (starts 'connecting'). */
  state$: Observable<MultiLogState>;
  /** `since` (RFC3339) time-anchors the first fetch (Docker Since) — used to land
   *  the view at a specific moment, e.g. when pivoting from an Insights error. */
  subscribe(id: string, tail?: string, since?: string): void;
  unsubscribe(id: string): void;
  /** Push the active level filter to the server so non-matching lines are dropped
   *  before they cross the wire. '' / 'all' streams everything; takes effect
   *  immediately without a refetch. */
  setLevel(level: string): void;
  /** Re-establish the follow for an already-active container from our last-seen
   *  point (Docker Since). Used when a container restarts: its server-side log
   *  stream ends, so we re-subscribe with the tracked `since` to recover the tail
   *  without a gap or duplicate history. No-op when the id isn't active. */
  resync(id: string): void;
  close(): void;
}

@Injectable({ providedIn: 'root' })
export class WebSocketService {
  // Match the page protocol: wss:// when served over HTTPS, ws:// otherwise.
  // (Using ws:// on an HTTPS page hits the HTTP→HTTPS redirect and the handshake fails.)
  private wsBase = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

  constructor(private auth: AuthService) {}

  /** Appends the session token as a query param so the backend can authenticate
   *  the WebSocket (browsers cannot set Authorization headers on ws:// URLs). */
  private withToken(url: string): string {
    const t = this.auth.token;
    if (!t) return url;
    return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
  }

  streamLogs(containerId: string, tail = '100'): Observable<string> {
    return this.connect(`${this.wsBase}/ws/logs?id=${containerId}&tail=${tail}`);
  }

  /**
   * Opens ONE WebSocket that multiplexes logs from many containers, instead of one
   * socket per container. Drive it with subscribe/unsubscribe; demultiplex the
   * emitted frames by `id`. Reconnects with backoff and re-subscribes the active
   * set automatically.
   */
  streamMultiLogs(): MultiLogStream {
    const frames$ = new Subject<MultiLogFrame>();
    const state$ = new BehaviorSubject<MultiLogState>('connecting');
    // containerId → { tail, since }. `since` is the timestamp of the last line
    // we've seen for that container; on an involuntary reconnect we resume from
    // it (Docker `Since`) instead of replaying the whole tail again, which is
    // what used to dump duplicate history on every blip.
    const active = new Map<string, { tail: string; since?: string }>();
    let level = ''; // active server-side level filter; '' = all
    let ws: WebSocket | undefined;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const send = (obj: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const open = () => {
      if (closed || document.hidden) return; // pause the log firehose while backgrounded
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return; // idempotent
      state$.next(navigator.onLine ? 'connecting' : 'offline');
      ws = new WebSocket(this.withToken(`${this.wsBase}/ws/logs/multi`));
      ws.onopen = () => {
        attempt = 0;
        state$.next('live');
        // Re-subscribe the active set; resume from `since` when we have one so a
        // reconnect doesn't replay tail history we already showed.
        active.forEach((a, id) => send({ action: 'subscribe', id, tail: a.tail, since: a.since }));
        if (level) send({ action: 'level', level }); // re-apply the filter after a reconnect
      };
      ws.onmessage = (evt) => {
        try {
          const frame = JSON.parse(evt.data) as MultiLogFrame;
          // Track the latest timestamp per container as our reconnect resume point.
          if (frame.id && frame.ts) {
            const a = active.get(frame.id);
            if (a) a.since = frame.ts;
          }
          frames$.next(frame);
        } catch { /* ignore */ }
      };
      ws.onerror = () => { /* close handler reconnects */ };
      ws.onclose = () => {
        if (closed || document.hidden) return; // paused — onVisible reopens + re-subscribes
        state$.next(navigator.onLine ? 'reconnecting' : 'offline');
        attempt++;
        // Backoff with jitter so many followers don't reconnect in lockstep.
        const delay = Math.min(1000 * 2 ** attempt, 15000) * (0.7 + Math.random() * 0.6);
        timer = setTimeout(() => { if (!closed && !document.hidden) open(); }, delay);
      };
    };

    const onOffline = () => state$.next('offline');

    const onVisible = () => {
      if (closed) return;
      if (document.hidden) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
      } else if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        attempt = 0;
        open(); // onopen re-subscribes the active set
      }
    };

    open();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('offline', onOffline);

    return {
      frames$: frames$.asObservable(),
      state$: state$.asObservable(),
      // An explicit (re)subscribe wants `tail` history, so it clears any prior
      // resume point; reconnects keep the auto-tracked `since` instead.
      subscribe: (id: string, tail = '50', since?: string) => { active.set(id, { tail, since }); send({ action: 'subscribe', id, tail, since }); },
      unsubscribe: (id: string) => { active.delete(id); send({ action: 'unsubscribe', id }); },
      setLevel: (lvl: string) => { level = lvl === 'all' ? '' : lvl; send({ action: 'level', level }); },
      // Re-subscribe an active container using its tracked `since` (NOT clearing it
      // like an explicit subscribe does), so a follow that ended when the container
      // stopped is re-established from the last line we saw.
      resync: (id: string) => { const a = active.get(id); if (a) send({ action: 'subscribe', id, tail: a.tail, since: a.since }); },
      close: () => {
        closed = true;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', onVisible);
        window.removeEventListener('offline', onOffline);
        if (timer) clearTimeout(timer);
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
        frames$.complete();
        state$.complete();
      },
    };
  }

  streamStats(containerId: string): Observable<string> {
    return this.connect(`${this.wsBase}/ws/stats?id=${containerId}`);
  }

  streamDockerEvents(): Observable<string> {
    return this.connect(`${this.wsBase}/ws/events`);
  }

  streamProjectBuildLogs(id: number): Observable<BuildLogEvent> {
    return new Observable<BuildLogEvent>(observer => {
      const ws = new WebSocket(this.withToken(`${this.wsBase}/ws/projects/${id}/build-logs`));
      ws.onmessage = (evt) => {
        try {
          const msg: BuildLogEvent = JSON.parse(evt.data);
          observer.next(msg);
          if (msg.type === 'done' || msg.type === 'error') {
            observer.complete();
            ws.close();
          }
        } catch { /* ignore malformed frames */ }
      };
      ws.onerror = () => observer.error(new Error('WebSocket error'));
      ws.onclose = () => observer.complete();
      return () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };
    });
  }

  /** Streams per-step progress for an in-flight project deletion. Completes on
   *  the terminal 'done'/'error' frame. */
  streamProjectDeleteProgress(id: number): Observable<DeleteProgressEvent> {
    return new Observable<DeleteProgressEvent>(observer => {
      const ws = new WebSocket(this.withToken(`${this.wsBase}/ws/projects/${id}/delete-progress`));
      ws.onmessage = (evt) => {
        try {
          const msg: DeleteProgressEvent = JSON.parse(evt.data);
          observer.next(msg);
          if (msg.type === 'done' || msg.type === 'error') {
            observer.complete();
            ws.close();
          }
        } catch { /* ignore malformed frames */ }
      };
      ws.onerror = () => observer.error(new Error('WebSocket error'));
      ws.onclose = () => observer.complete();
      return () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };
    });
  }

  /** Opens an interactive exec session for a container. Returns an Observable of output lines.
   *  Use the returned WebSocket ref to send stdin. */
  streamExec(containerId: string, shell = '/bin/sh'): { output$: Observable<string>; send: (cmd: string) => void; close: () => void } {
    const url = this.withToken(`${this.wsBase}/ws/exec?id=${containerId}&shell=${encodeURIComponent(shell)}`);
    const ws = new WebSocket(url);
    const output$ = new Observable<string>(observer => {
      ws.onmessage = (event) => observer.next(event.data);
      ws.onerror = () => observer.error('WebSocket error');
      ws.onclose = () => observer.complete();
      return () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };
    });
    return {
      output$,
      send: (cmd: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(cmd);
      },
      close: () => ws.close(),
    };
  }

  /** Streams aggregated stats for ALL running containers, emitting
   *  ContainerStatSummary[] every ~3s. */
  streamAllStats(): Observable<ContainerStatSummary[]> {
    return this.reconnectingSocket(`${this.wsBase}/ws/allstats`, (raw) => JSON.parse(raw) as ContainerStatSummary[]);
  }

  // Shared connector for the followed streams (logs/stats/events). Reconnects
  // with capped exponential backoff so a transient drop (engine blip, laptop
  // sleep) recovers instead of freezing the panel forever. Stops on unsubscribe.
  private connect(url: string): Observable<string> {
    return this.reconnectingSocket(url, (raw) => raw);
  }

  /**
   * A WebSocket that reconnects with capped exponential backoff AND pauses while
   * the tab is hidden — it closes the socket when the page is backgrounded (phone
   * locked / app switched) to save battery + data, and reopens on foreground.
   */
  private reconnectingSocket<T>(url: string, parse: (raw: string) => T): Observable<T> {
    return new Observable<T>(observer => {
      let closed = false;
      let attempt = 0;
      let ws: WebSocket | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = undefined; } };

      const open = () => {
        if (closed || document.hidden) return; // don't connect while backgrounded
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return; // idempotent: never clobber a live socket
        ws = new WebSocket(this.withToken(url));
        ws.onmessage = (event) => { try { observer.next(parse(event.data)); } catch { /* ignore */ } };
        ws.onerror = () => { /* the close handler schedules the reconnect */ };
        ws.onopen = () => { attempt = 0; };
        ws.onclose = () => {
          if (closed || document.hidden) return; // paused — onVisible reopens
          attempt++;
          timer = setTimeout(() => { if (!closed && !document.hidden) open(); }, Math.min(1000 * 2 ** attempt, 15000));
        };
      };

      const onVisible = () => {
        if (closed) return;
        if (document.hidden) {
          clearTimer();
          if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
        } else if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          attempt = 0;
          open();
        }
      };

      open();
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', onVisible); // reconnect immediately when the network returns

      return () => {
        closed = true;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', onVisible);
        clearTimer();
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      };
    });
  }
}

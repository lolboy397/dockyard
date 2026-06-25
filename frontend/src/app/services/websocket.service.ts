import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
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

/** One multiplexed log line, tagged with the container it came from. */
export interface MultiLogFrame {
  id: string;
  data: string;
}

/** Controller for a single multiplexed log WebSocket (see streamMultiLogs). */
export interface MultiLogStream {
  frames$: Observable<MultiLogFrame>;
  subscribe(id: string, tail?: string): void;
  unsubscribe(id: string): void;
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
    const active = new Map<string, string>();   // containerId → tail
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
      ws = new WebSocket(this.withToken(`${this.wsBase}/ws/logs/multi`));
      ws.onopen = () => {
        attempt = 0;
        active.forEach((tail, id) => send({ action: 'subscribe', id, tail }));
      };
      ws.onmessage = (evt) => {
        try { frames$.next(JSON.parse(evt.data) as MultiLogFrame); } catch { /* ignore */ }
      };
      ws.onerror = () => { /* close handler reconnects */ };
      ws.onclose = () => {
        if (closed || document.hidden) return; // paused — onVisible reopens + re-subscribes
        attempt++;
        timer = setTimeout(() => { if (!closed && !document.hidden) open(); }, Math.min(1000 * 2 ** attempt, 15000));
      };
    };

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

    return {
      frames$: frames$.asObservable(),
      subscribe: (id: string, tail = '50') => { active.set(id, tail); send({ action: 'subscribe', id, tail }); },
      unsubscribe: (id: string) => { active.delete(id); send({ action: 'unsubscribe', id }); },
      close: () => {
        closed = true;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', onVisible);
        if (timer) clearTimeout(timer);
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
        frames$.complete();
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

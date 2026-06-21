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

  /** Streams aggregated stats for ALL running containers, emitting ContainerStatSummary[] every ~3s. */
  streamAllStats(): Observable<ContainerStatSummary[]> {
    return new Observable<ContainerStatSummary[]>(observer => {
      const ws = new WebSocket(this.withToken(`${this.wsBase}/ws/allstats`));
      ws.onmessage = (event) => {
        try { observer.next(JSON.parse(event.data)); } catch { /* ignore */ }
      };
      ws.onerror = () => observer.error('WebSocket error');
      ws.onclose = () => observer.complete();
      return () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };
    });
  }

  // Shared connector for the followed streams (logs/stats/events). Reconnects
  // with capped exponential backoff so a transient drop (engine blip, laptop
  // sleep) recovers instead of freezing the panel forever. Stops on unsubscribe.
  private connect(url: string): Observable<string> {
    return new Observable<string>(observer => {
      let closed = false;
      let attempt = 0;
      let ws: WebSocket;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const open = () => {
        ws = new WebSocket(this.withToken(url));
        ws.onmessage = (event) => observer.next(event.data);
        ws.onerror = () => { /* the close handler schedules the reconnect */ };
        ws.onopen = () => { attempt = 0; };
        ws.onclose = () => {
          if (closed) return;
          attempt++;
          const delay = Math.min(1000 * 2 ** attempt, 15000);
          timer = setTimeout(() => { if (!closed) open(); }, delay);
        };
      };
      open();

      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      };
    });
  }
}

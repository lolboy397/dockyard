import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface DiagGroup {
  fingerprint: string;
  title: string;
  level: string;   // info | warn | error
  source: string;  // backend | frontend
  first_seen: string;
  last_seen: string;
  count: number;
  status: string;  // open | resolved | muted
}

export interface DiagEvent {
  id: number;
  ts: string;
  level: string;
  source: string;
  component: string;
  message: string;
  fingerprint: string;
  request_id: string;
  actor: string;
  route: string;
  status_code: number;
  stack?: string;
  context?: string;
  release: string;
  user_agent?: string;
}

export interface DiagStats {
  open_groups: number;
  events_24h: number;
  by_level: Record<string, number>;
  by_source: Record<string, number>;
}

/** Admin client for the Dockyard Insights diagnostics store. */
@Injectable({ providedIn: 'root' })
export class DiagService {
  private http = inject(HttpClient);

  stats(): Observable<DiagStats> {
    return this.http.get<DiagStats>('/api/v1/diag/stats');
  }

  groups(status = '', source = ''): Observable<DiagGroup[]> {
    let p = new HttpParams();
    if (status) p = p.set('status', status);
    if (source) p = p.set('source', source);
    return this.http.get<DiagGroup[]>('/api/v1/diag/groups', { params: p });
  }

  events(fingerprint: string): Observable<DiagEvent[]> {
    return this.http.get<DiagEvent[]>('/api/v1/diag/events', { params: new HttpParams().set('fingerprint', fingerprint) });
  }

  setStatus(fingerprint: string, status: 'open' | 'resolved' | 'muted'): Observable<unknown> {
    return this.http.post(`/api/v1/diag/groups/${fingerprint}/status`, { status });
  }
}

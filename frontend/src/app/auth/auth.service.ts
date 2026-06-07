import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { AuthSession, AuthStatus, AuthUser, SetupData, TestConnectionResult } from './auth.models';

const TOKEN_KEY = 'dy_token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private base = '/api/v1/auth';

  /** True once the initial status/session probe has resolved. */
  readonly ready = signal(false);
  /** True when a valid session is held. */
  readonly authed = signal(false);
  readonly user = signal<AuthUser | null>(null);
  readonly status = signal<AuthStatus | null>(null);

  constructor(private http: HttpClient) {}

  get token(): string | null { return localStorage.getItem(TOKEN_KEY); }

  /** Probe instance status and validate any stored session token. */
  init(): void {
    this.http.get<AuthStatus>(`${this.base}/status`).pipe(
      catchError(() => of(null)),
    ).subscribe(s => {
      if (s) this.status.set(s);
      const token = this.token;
      if (!token) { this.ready.set(true); return; }
      this.http.get<AuthUser>(`${this.base}/me`, { headers: this.authHeaders() }).pipe(
        catchError(() => of(null)),
      ).subscribe(u => {
        if (u) { this.user.set(u); this.authed.set(true); }
        else { localStorage.removeItem(TOKEN_KEY); }
        this.ready.set(true);
      });
    });
  }

  refreshStatus(): Observable<AuthStatus | null> {
    return this.http.get<AuthStatus>(`${this.base}/status`).pipe(
      tap(s => this.status.set(s)),
      catchError(() => of(null)),
    );
  }

  setup(data: SetupData): Observable<AuthSession> {
    // Setup creates the admin but deliberately does NOT sign the user in — the
    // design flow hands off to the login screen ("you'll sign in next").
    return this.http.post<AuthSession>(`${this.base}/setup`, data).pipe(
      tap(() => this.refreshStatus().subscribe()),
    );
  }

  login(username: string, password: string, remember: boolean): Observable<AuthSession> {
    // Stores the session but does NOT flip `authed` — the login screen plays its
    // "Signed in" success card first, then calls markAuthed() to enter the app.
    return this.http.post<AuthSession>(`${this.base}/login`, { username, password, remember }).pipe(
      tap(res => this.persist(res)),
    );
  }

  /** Reveal the app shell once the post-login success card has played. */
  markAuthed(): void { this.authed.set(true); }

  /** Called by the HTTP interceptor when a request is rejected with 401 — drop
   *  the stored session and fall back to the login screen. */
  handleUnauthorized(): void {
    localStorage.removeItem(TOKEN_KEY);
    this.authed.set(false);
    this.user.set(null);
  }

  // ---- Role helpers (read from the current user signal) ----
  // Mirror the backend authorization tiers for the built-in roles so the UI
  // gates correctly regardless of which system role the user holds. The backend
  // remains the source of truth for enforcement (including custom roles).
  isAdmin(): boolean { const r = this.user()?.role; return r === 'admin' || r === 'owner'; }
  isViewer(): boolean { return this.user()?.role === 'viewer'; }
  /** True when the user may perform mutating actions (admin or operator tier). */
  canWrite(): boolean {
    const r = this.user()?.role ?? '';
    return ['admin', 'owner', 'operator', 'maintainer', 'developer'].includes(r);
  }

  // ---- User administration (admin only) ----
  listUsers(): Observable<AuthUser[]> {
    return this.http.get<AuthUser[]>('/api/v1/users');
  }
  createUser(body: { fullName: string; email: string; username: string; password: string; role: string }): Observable<AuthUser> {
    return this.http.post<AuthUser>('/api/v1/users', body);
  }
  updateUser(id: number, patch: Partial<{ fullName: string; email: string; role: string; status: string; twoFactor: boolean; active: boolean; password: string }>): Observable<AuthUser> {
    return this.http.patch<AuthUser>(`/api/v1/users/${id}`, patch);
  }
  deleteUser(id: number): Observable<unknown> {
    return this.http.delete(`/api/v1/users/${id}`);
  }

  testConnection(): Observable<TestConnectionResult> {
    return this.http.post<TestConnectionResult>(`${this.base}/test-connection`, {}).pipe(
      catchError(err => of<TestConnectionResult>({ ok: false, error: err?.message ?? 'connection failed' })),
    );
  }

  logout(): void {
    const token = this.token;
    if (token) {
      this.http.post(`${this.base}/logout`, {}, { headers: this.authHeaders() })
        .pipe(catchError(() => of(null))).subscribe();
    }
    localStorage.removeItem(TOKEN_KEY);
    this.authed.set(false);
    this.user.set(null);
  }

  private persist(res: AuthSession): void {
    if (res?.token) localStorage.setItem(TOKEN_KEY, res.token);
    this.user.set(res?.user ?? null);
  }

  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.token ?? ''}` });
  }
}

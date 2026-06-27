import { Injectable, signal } from '@angular/core';
import { HttpClient, HttpHeaders, HttpErrorResponse } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { AuthSession, AuthStatus, AuthUser, SetupData, TestConnectionResult, TwoFactorChallenge, TwoFactorStatus } from './auth.models';
import { clearAllCaches } from '../services/pwa-update.service';

const TOKEN_KEY = 'dy_token';
// Last-known user, cached so an offline / installed-PWA cold relaunch can paint
// the real account instead of flashing the login screen (see init()).
const USER_KEY = 'dy_user';

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
    // Restore the last-known user up front so an offline relaunch has something
    // to fall back on if /me can't be reached.
    const cached = this.readCachedUser();
    this.http.get<AuthStatus>(`${this.base}/status`).pipe(
      catchError(() => of(null)),
    ).subscribe(s => {
      if (s) this.status.set(s);
      const token = this.token;
      if (!token) { this.cacheUser(null); this.ready.set(true); return; }
      this.http.get<AuthUser>(`${this.base}/me`, { headers: this.authHeaders() }).subscribe({
        next: u => {
          this.user.set(u);
          this.cacheUser(u);
          this.authed.set(true);
          this.ready.set(true);
        },
        error: (err: HttpErrorResponse) => {
          // CRITICAL: optimistically authenticate ONLY on a genuine network
          // failure (status 0: offline, server unreachable, installed-PWA cold
          // relaunch) — keep the token + cached user so the shell loads and
          // re-validates when back online. A reachable server that REJECTS us
          // (401 expired, 403 suspended, 404 deleted, 5xx) must clear the
          // session, otherwise a revoked account is trapped in the shell.
          if (err.status === 0) {
            if (cached) this.user.set(cached);
            this.authed.set(true);
          } else {
            localStorage.removeItem(TOKEN_KEY);
            this.cacheUser(null);
            this.authed.set(false);
            this.user.set(null);
          }
          this.ready.set(true);
        },
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

  login(username: string, password: string, remember: boolean, otp?: string): Observable<AuthSession | TwoFactorChallenge> {
    // Stores the session but does NOT flip `authed` — the login screen plays its
    // "Signed in" success card first, then calls markAuthed() to enter the app.
    // When the account has 2FA on and no code was sent, the server returns a
    // {two_factor_required} challenge (no token) and the screen asks for a code.
    return this.http.post<AuthSession | TwoFactorChallenge>(`${this.base}/login`, { username, password, remember, otp }).pipe(
      tap(res => { if ('token' in res && res.token) this.persist(res); }),
    );
  }

  // ---- Two-factor (TOTP) self-service ----
  twoFactorStatus(): Observable<TwoFactorStatus> {
    return this.http.get<TwoFactorStatus>(`${this.base}/2fa`, { headers: this.authHeaders() });
  }
  twoFactorSetup(): Observable<{ secret: string; otpauth_url: string }> {
    return this.http.post<{ secret: string; otpauth_url: string }>(`${this.base}/2fa/setup`, {}, { headers: this.authHeaders() });
  }
  twoFactorConfirm(code: string): Observable<{ enabled: boolean; backup_codes: string[] }> {
    return this.http.post<{ enabled: boolean; backup_codes: string[] }>(`${this.base}/2fa/confirm`, { code }, { headers: this.authHeaders() }).pipe(
      tap(() => this.setUserTwoFactor(true)),
    );
  }
  twoFactorDisable(password: string): Observable<{ enabled: boolean }> {
    return this.http.post<{ enabled: boolean }>(`${this.base}/2fa/disable`, { password }, { headers: this.authHeaders() }).pipe(
      tap(() => this.setUserTwoFactor(false)),
    );
  }
  /** Reflect a 2FA enable/disable in the cached current-user signal. */
  private setUserTwoFactor(enabled: boolean): void {
    const u = this.user();
    if (u) { const next = { ...u, two_factor_enabled: enabled }; this.user.set(next); this.cacheUser(next); }
  }

  /** Reveal the app shell once the post-login success card has played. */
  markAuthed(): void { this.authed.set(true); }

  /** Called by the HTTP interceptor when a request is rejected with 401 — drop
   *  the stored session and fall back to the login screen. */
  handleUnauthorized(): void {
    localStorage.removeItem(TOKEN_KEY);
    this.cacheUser(null);
    void clearAllCaches();
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
    this.cacheUser(null);
    void clearAllCaches();
    this.authed.set(false);
    this.user.set(null);
  }

  private persist(res: AuthSession): void {
    if (res?.token) localStorage.setItem(TOKEN_KEY, res.token);
    this.user.set(res?.user ?? null);
    this.cacheUser(res?.user ?? null);
  }

  private cacheUser(u: AuthUser | null): void {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  }

  private readCachedUser(): AuthUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as AuthUser) : null;
    } catch {
      return null;
    }
  }

  private authHeaders(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.token ?? ''}` });
  }
}

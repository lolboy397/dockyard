import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ActivityEvent, CapabilityCatalogue, Role, RoleDetail, SessionInfo } from '../auth/auth.models';

/**
 * Admin API client for the Members/Roles screens: the role catalogue,
 * capability definitions, and per-member activity/sessions. User CRUD lives on
 * AuthService; this covers everything role- and member-detail-specific.
 */
@Injectable({ providedIn: 'root' })
export class AdminService {
  constructor(private http: HttpClient) {}

  listRoles(): Observable<Role[]> {
    return this.http.get<Role[]>('/api/v1/roles');
  }

  getRole(id: string): Observable<RoleDetail> {
    return this.http.get<RoleDetail>(`/api/v1/roles/${id}`);
  }

  getCapabilities(): Observable<CapabilityCatalogue> {
    return this.http.get<CapabilityCatalogue>('/api/v1/roles/capabilities');
  }

  createRole(body: { name: string; description: string; icon: string; capabilities: Record<string, string> }): Observable<Role> {
    return this.http.post<Role>('/api/v1/roles', body);
  }

  deleteRole(id: string): Observable<unknown> {
    return this.http.delete(`/api/v1/roles/${id}`);
  }

  userActivity(id: number): Observable<ActivityEvent[]> {
    return this.http.get<ActivityEvent[]>(`/api/v1/users/${id}/activity`);
  }

  userSessions(id: number): Observable<SessionInfo[]> {
    return this.http.get<SessionInfo[]>(`/api/v1/users/${id}/sessions`);
  }

  /** Sign a user out of all sessions except the caller's current one. */
  revokeUserSessions(id: number): Observable<{ revoked: number }> {
    return this.http.delete<{ revoked: number }>(`/api/v1/users/${id}/sessions`);
  }
}

/** The data the setup wizard collects. Only fields that actually take effect are
 *  gathered: the admin account and the instance name. Docker host, bind address,
 *  data dir, TLS, auto-update, telemetry and default-registry are all fixed by the
 *  deployment (compose env / socket proxy), so they are not asked for here. */
export interface SetupData {
  // welcome
  accepted: boolean;
  // admin
  fullName: string;
  email: string;
  username: string;
  password: string;
  confirm: string;
  // instance
  instanceName: string;
}

export const DEFAULT_DATA: SetupData = {
  accepted: false,
  fullName: '', email: '', username: '', password: '', confirm: '',
  instanceName: 'production',
};

export interface AuthUser {
  id: number;
  full_name: string;
  email: string;
  username: string;
  role: string;
  active?: boolean;
  created_at?: string;
  status?: string;             // active | invited | suspended
  two_factor_enabled?: boolean;
  auth_method?: string;        // password | SSO · … | invite pending
  last_active_at?: string | null;
}

/** A role: a named bundle of capabilities (system or custom). */
export interface Role {
  id: string;
  name: string;
  description: string;
  icon: string;
  type: 'system' | 'custom';
  tier: string;                       // admin | operator | viewer
  level: string;                      // short access-level label
  capabilities: Record<string, string>; // capability key → all|scoped|read|none
  members: number;
  created_at?: string;
}

/** A role plus the accounts assigned to it (GET /roles/{id}). */
export interface RoleDetail extends Role {
  member_list: AuthUser[];
}

/** The capability catalogue (GET /roles/capabilities). */
export interface CapabilityCatalogue {
  groups: { group: string; rows: { key: string; label: string }[] }[];
  states: { value: string; label: string }[];
}

/** One audited event attributed to a member (GET /users/{id}/activity). */
export interface ActivityEvent {
  id: number;
  created_at: string;
  kind: string;
  actor: string;
  object_type: string;
  object_name: string;
  message: string;
}

/** An active sign-in session (GET /users/{id}/sessions). */
export interface SessionInfo {
  user_agent: string;
  ip: string;
  created_at: string;
  expires_at: string;
  current: boolean;
}

export interface AuthStatus {
  setup_complete: boolean;
  instance_name: string;
  docker_host: string;
  bind_addr: string;
  registry: string;
  engine_version: string;
  app_version: string;
}

export interface AuthSession {
  token: string;
  expires_at: string;
  user: AuthUser;
}

export interface TestConnectionResult {
  ok: boolean;
  containers?: number;
  images?: number;
  engine_version?: string;
  error?: string;
}

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
  /** Resolved server-side: operator+ tier OR a role granted the logs.view
   *  capability. Lets the Logs page gate in step with the backend, custom roles
   *  included. Omitted (falsey) when not granted. */
  can_view_logs?: boolean;
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
  sso_enabled?: boolean;
  sso_label?: string;
}

/** Single-provider SSO (OIDC) configuration, admin-managed. The client secret is
 *  never returned (has_secret signals whether one is stored). */
export interface OIDCConfig {
  enabled: boolean;
  issuer_url: string;
  client_id: string;
  client_secret?: string; // write-only; sent on save, never returned
  has_secret?: boolean;
  button_label: string;
  allowed_domains: string;
  default_role: string;
  auto_provision: boolean;
}

export interface AuthSession {
  token: string;
  expires_at: string;
  user: AuthUser;
}

/** Returned by /auth/login when the account has 2FA on and no code was supplied:
 *  the client collects a code and re-submits. No token is issued at this step. */
export interface TwoFactorChallenge {
  two_factor_required: true;
}

/** Current user's two-factor state (GET /auth/2fa). */
export interface TwoFactorStatus {
  enabled: boolean;
  pending: boolean;
  backup_codes_remaining: number;
}

export interface TestConnectionResult {
  ok: boolean;
  containers?: number;
  images?: number;
  engine_version?: string;
  error?: string;
}

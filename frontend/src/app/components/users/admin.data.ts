/* =========================================================================
   Dockyard — Admin (Members/Roles) shared helpers.
   View-model formatting + capability display used by the Members and Roles
   screens, which are backed by the real API (see AdminService / AuthService).
   Environment-scoped access is intentionally not modelled yet.
   ========================================================================= */
import { AuthUser, Role, SessionInfo } from '../../auth/auth.models';

/** Status → badge tone. */
export function statusTone(status: string): string {
  switch (status) {
    case 'active': return 'running';
    case 'invited': return 'warn';
    case 'suspended': return 'danger';
    default: return 'idle';
  }
}

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active', invited: 'Invited', suspended: 'Suspended',
};

/** Effective status for a user (status field, falling back to the active flag). */
export function userStatus(u: AuthUser): string {
  if (u.status) return u.status;
  return u.active === false ? 'suspended' : 'active';
}

/** Two initials from a display name / username. */
export function initials(u: AuthUser): string {
  const s = (u.full_name || u.username || '?').trim();
  const parts = s.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase();
}

/** Compact relative time, e.g. "2m ago" / "3h ago" / "5d ago"; "—" when empty. */
export function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '—';
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 90) return '1m ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** "Mon YYYY" from an ISO date, e.g. "Jan 2024". */
export function monthYear(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

/* ----- Capabilities ---------------------------------------------------- */

export interface CapStateMeta { cls: string; icon: string | null; label: string; }

/** Capability state → matrix cell display (environment-agnostic labels). */
export const CAP_STATE: Record<string, CapStateMeta> = {
  all:    { cls: 'all',    icon: 'check', label: 'full' },
  scoped: { cls: 'scoped', icon: 'check', label: 'scoped' },
  read:   { cls: 'read',   icon: null,    label: 'read-only' },
  none:   { cls: 'none',   icon: null,    label: '—' },
};

export function capMeta(state: string | undefined): CapStateMeta {
  return CAP_STATE[state || 'none'] || CAP_STATE['none'];
}

/** Whether a role grants a capability at all (anything but none). */
function granted(role: Role | undefined, key: string): boolean {
  return !!role && (role.capabilities?.[key] ?? 'none') !== 'none';
}

/** The simplified yes/no capability summary shown on the member Access tab. */
export function memberCapabilities(role: Role | undefined): { label: string; yes: boolean }[] {
  return [
    { label: 'Manage users', yes: granted(role, 'org.members') },
    { label: 'Deploy & restart', yes: granted(role, 'deploy.rollback') || granted(role, 'containers.lifecycle') },
    { label: 'View logs', yes: granted(role, 'containers.view') },
    { label: 'Prune resources', yes: granted(role, 'infra.prune') || granted(role, 'images.prune') },
  ];
}

/* ----- Activity & sessions --------------------------------------------- */

export interface ActRail { rail: string; icon: string; }

/** Map an audit/event kind to an activity-feed rail tone + icon. */
export function activityRail(kind: string): ActRail {
  const k = (kind || '').toLowerCase();
  if (k === 'audit') return { rail: 'info', icon: 'activity' };
  if (k.startsWith('start') || k === 'create' || k === 'deploy') return { rail: 'running', icon: 'rocket' };
  if (k.startsWith('stop') || k === 'die' || k === 'kill') return { rail: 'warn', icon: 'square' };
  if (k.startsWith('remove') || k === 'destroy' || k === 'delete') return { rail: 'danger', icon: 'trash-2' };
  if (k.startsWith('build') || k === 'pull' || k === 'push') return { rail: 'info', icon: 'hammer' };
  if (k === 'login' || k === 'logout') return { rail: 'idle', icon: 'log-in' };
  return { rail: 'idle', icon: 'circle-dot' };
}

/** Best-effort device label + icon parsed from a session user-agent. */
export function sessionDevice(s: SessionInfo): { label: string; icon: string } {
  const ua = (s.user_agent || '').trim();
  if (!ua) return { label: 'Unknown device', icon: 'help-circle' };
  const l = ua.toLowerCase();

  // Command-line / programmatic clients first (these aren't "OS · Browser").
  const tool =
    /curl\//.test(l) ? 'curl' :
    /wget/.test(l) ? 'wget' :
    /git\//.test(l) ? 'Git' :
    /powershell/.test(l) ? 'PowerShell' :
    /python-requests/.test(l) ? 'Python' :
    /go-http-client/.test(l) ? 'Go client' :
    /postmanruntime/.test(l) ? 'Postman' :
    /insomnia/.test(l) ? 'Insomnia' :
    /dockyard\//.test(l) ? 'Dockyard CLI' : '';
  if (tool) return { label: tool, icon: 'terminal' };

  let os = '';
  if (/windows nt/.test(l)) os = 'Windows';
  else if (/mac os|macintosh/.test(l)) os = 'macOS';
  else if (/iphone|ipad|ios/.test(l)) os = 'iOS';
  else if (/android/.test(l)) os = 'Android';
  else if (/cros/.test(l)) os = 'ChromeOS';
  else if (/linux/.test(l)) os = 'Linux';

  // Order matters: Edge/Opera spoof the Chrome token, so test them first.
  let browser = '';
  if (/edg(a|ios)?\//.test(l)) browser = 'Edge';
  else if (/opr\/|opera/.test(l)) browser = 'Opera';
  else if (/chrome\//.test(l)) browser = 'Chrome';
  else if (/firefox\//.test(l)) browser = 'Firefox';
  else if (/version\/[\d.]+ .*safari/.test(l)) browser = 'Safari';

  const icon = /iphone|ipad|android|mobile/.test(l) ? 'smartphone' : 'monitor';
  const label = [os, browser].filter(Boolean).join(' · ') || 'Browser';
  return { label, icon };
}

/** Human-friendly location from a session IP. Behind Docker's port NAT a local
 *  instance reports the bridge gateway (a private 172.x), so private/loopback
 *  addresses are summarised rather than shown raw. */
export function sessionLocation(ip: string): string {
  const v = (ip || '').trim();
  if (!v) return 'Unknown location';
  if (v === '127.0.0.1' || v === '::1') return 'Localhost';
  if (
    /^10\./.test(v) ||
    /^192\.168\./.test(v) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v) || // 172.16–31 (incl. Docker bridges)
    /^169\.254\./.test(v) ||                // IPv4 link-local
    /^fe80:/i.test(v) || /^f[cd]/i.test(v)  // IPv6 link-local / ULA
  ) return 'Private network';
  return v; // public address
}

/* global React, Icon, Btn, Badge, ROLE_META, MEMBERS */
const { useState: useRState } = React;

/* Role list — the 6 system roles plus one example custom role.
   Member counts tie back to MEMBERS. */
const ROLES = [
  { id: 'owner',      icon: 'crown',       type: 'system', members: 1, envSummary: 'All environments', level: 'Full access' },
  { id: 'admin',      icon: 'shield',      type: 'system', members: 2, envSummary: 'All environments', level: 'Manage + deploy' },
  { id: 'maintainer', icon: 'wrench',      type: 'system', members: 2, envSummary: '3 environments',    level: 'Operate + deploy' },
  { id: 'developer',  icon: 'code',        type: 'system', members: 4, envSummary: 'staging, dev',       level: 'Build + operate' },
  { id: 'viewer',     icon: 'eye',         type: 'system', members: 2, envSummary: '3 · read-only',      level: 'Read-only' },
  { id: 'billing',    icon: 'credit-card', type: 'system', members: 1, envSummary: 'No access',          level: 'Billing only' },
  { id: 'sre',        icon: 'siren',       type: 'custom', members: 0, envSummary: 'production',          level: 'Operate (prod)',
    label: 'On-call SRE', desc: 'Operate and deploy production only. For rotation engineers handling incidents.' },
];

const ROLE_ENV = {
  owner:      [['production','deploy'],['staging','deploy'],['dev','deploy']],
  admin:      [['production','write'], ['staging','write'], ['dev','write']],
  maintainer: [['production','deploy'],['staging','read'],  ['dev','read']],
  developer:  [['production','none'],  ['staging','write'], ['dev','deploy']],
  viewer:     [['production','read'],  ['staging','read'],  ['dev','read']],
  billing:    [['production','none'],  ['staging','none'],  ['dev','none']],
  sre:        [['production','deploy'],['staging','none'],  ['dev','none']],
};
const PERM_TXT = { deploy: 'deploy', write: 'write', read: 'read', none: 'no access' };

/* Capability matrix. Each value is one of: all | scoped | read | none */
const CAP_GROUPS = [
  { group: 'Containers', rows: [
    { label: 'View containers & logs', vals: { owner:'all', admin:'all', maintainer:'all', developer:'all', viewer:'read', billing:'none', sre:'all' } },
    { label: 'Start, stop, restart',   vals: { owner:'all', admin:'all', maintainer:'all', developer:'scoped', viewer:'none', billing:'none', sre:'scoped' } },
    { label: 'Open shell / exec',      vals: { owner:'all', admin:'all', maintainer:'all', developer:'scoped', viewer:'none', billing:'none', sre:'scoped' } },
    { label: 'Remove containers',      vals: { owner:'all', admin:'all', maintainer:'scoped', developer:'none', viewer:'none', billing:'none', sre:'scoped' } },
  ]},
  { group: 'Images & builds', rows: [
    { label: 'Pull images',     vals: { owner:'all', admin:'all', maintainer:'all', developer:'scoped', viewer:'read', billing:'none', sre:'scoped' } },
    { label: 'Build images',    vals: { owner:'all', admin:'all', maintainer:'all', developer:'scoped', viewer:'none', billing:'none', sre:'none' } },
    { label: 'Push to registry',vals: { owner:'all', admin:'all', maintainer:'scoped', developer:'none', viewer:'none', billing:'none', sre:'none' } },
    { label: 'Prune images',    vals: { owner:'all', admin:'all', maintainer:'scoped', developer:'none', viewer:'none', billing:'none', sre:'scoped' } },
  ]},
  { group: 'Infrastructure', rows: [
    { label: 'Volumes & networks', vals: { owner:'all', admin:'all', maintainer:'scoped', developer:'scoped', viewer:'read', billing:'none', sre:'scoped' } },
    { label: 'Prune resources',    vals: { owner:'all', admin:'all', maintainer:'scoped', developer:'none', viewer:'none', billing:'none', sre:'scoped' } },
  ]},
  { group: 'Deployments', rows: [
    { label: 'Deploy & rollback', vals: { owner:'all', admin:'all', maintainer:'scoped', developer:'scoped', viewer:'none', billing:'none', sre:'scoped' } },
  ]},
  { group: 'Organization', rows: [
    { label: 'Invite & remove members', vals: { owner:'all', admin:'all', maintainer:'none', developer:'none', viewer:'none', billing:'none', sre:'none' } },
    { label: 'Manage roles',            vals: { owner:'all', admin:'all', maintainer:'none', developer:'none', viewer:'none', billing:'none', sre:'none' } },
    { label: 'Manage billing',          vals: { owner:'all', admin:'none', maintainer:'none', developer:'none', viewer:'none', billing:'all', sre:'none' } },
    { label: 'API tokens & registries', vals: { owner:'all', admin:'all', maintainer:'scoped', developer:'none', viewer:'none', billing:'none', sre:'scoped' } },
  ]},
];

const CAP_STATE = {
  all:    { cls: 'all',    icon: 'check',  label: 'all envs' },
  scoped: { cls: 'scoped', icon: 'check',  label: 'assigned' },
  read:   { cls: 'read',   icon: null,     label: 'read-only' },
  none:   { cls: 'none',   icon: null,     label: '—' },
};

function roleName(r) { return r.label || ROLE_META[r.id]?.label || r.id; }
function roleDesc(r) { return r.desc || ROLE_META[r.id]?.desc || ''; }

/* =========================================================================
   ROLES — list
   ========================================================================= */
function RolesPage({ rows, selectedId, setSelectedId, filter, setFilter, onNewRole }) {
  const filtered = rows.filter(r => filter === 'all' || r.type === filter);
  const cols = 'minmax(0,1.7fr) 84px minmax(0,1.25fr) 132px 30px';
  const counts = {
    all: rows.length,
    system: rows.filter(r => r.type === 'system').length,
    custom: rows.filter(r => r.type === 'custom').length,
  };

  return (
    <div className="content-area">
      <div className="content-head">
        <div className="content-title-row">
          <h2 className="content-title">Roles</h2>
          <span className="content-count mono">{filtered.length} of {rows.length}</span>
        </div>
        <div className="content-actions">
          <Btn variant="ghost" icon="git-compare">Compare</Btn>
          <span className="divider-v" />
          <Btn variant="primary" icon="plus" onClick={onNewRole}>New role</Btn>
        </div>
      </div>

      <div className="content-toolbar">
        <div className="pills">
          {[
            { id: 'all',    label: 'All' },
            { id: 'system', label: 'System' },
            { id: 'custom', label: 'Custom' },
          ].map(f => (
            <button key={f.id} className={`pill ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}<span className="pill-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-meta mono">{counts.system} system · {counts.custom} custom</div>
      </div>

      <div className="gtable roles-table">
        <div className="gtable-head" style={{ gridTemplateColumns: cols }}>
          <span>Role</span>
          <span>Members</span>
          <span>Environment access</span>
          <span>Access level</span>
          <span></span>
        </div>
        {filtered.map(r => (
          <div
            key={r.id}
            className={`gtable-row roles-row ${selectedId === r.id ? 'sel' : ''}`}
            style={{ gridTemplateColumns: cols }}
            onClick={() => setSelectedId(r.id)}
          >
            <span className="role-list-name">
              <span className={`role-ic ${r.id === 'owner' ? 'owner' : ''} ${r.type === 'custom' ? 'custom' : ''}`}>
                <Icon name={r.icon} size={15} />
              </span>
              <span className="role-list-text">
                <span className="role-list-title">{roleName(r)}</span>
                <span className="mini-tag">{r.type}</span>
              </span>
            </span>
            <span className="mono" style={{ color: r.members ? 'var(--fg-default)' : 'var(--fg-subtle)' }}>{r.members}</span>
            <span className="mono" style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{r.envSummary}</span>
            <span className="access-level">{r.level}</span>
            <span onClick={e => e.stopPropagation()}>
              <button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   ROLE — detail
   ========================================================================= */
function CapVal({ state }) {
  const s = CAP_STATE[state] || CAP_STATE.none;
  return (
    <span className={`cap-val ${s.cls}`}>
      {s.icon && <Icon name={s.icon} size={12} />}
      {s.label}
    </span>
  );
}

function RoleDetail({ role, onClose }) {
  if (!role) return null;
  const envs = role.env || ROLE_ENV[role.id] || [];
  const people = (typeof MEMBERS !== 'undefined' ? MEMBERS : []).filter(m => m.role === role.id);

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-id">
          <span className={`role-ic lg ${role.id === 'owner' ? 'owner' : ''} ${role.type === 'custom' ? 'custom' : ''}`}>
            <Icon name={role.icon} size={20} />
          </span>
          <div className="member-text">
            <span className="detail-eyebrow">{role.type} role</span>
            <span className="detail-title">{roleName(role)}</span>
            <span className="detail-sub mono">{role.members} member{role.members === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div className="detail-head-actions">
          <Btn variant="ghost" size="sm" icon={role.type === 'system' ? 'copy' : 'pencil'}>
            {role.type === 'system' ? 'Duplicate' : 'Edit'}
          </Btn>
          <button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button>
          <button className="icon-btn ghost sm" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
      </div>

      <div className="detail-body">
        <div className="dbody">
          <p className="role-detail-desc">{roleDesc(role)}</p>

          <div className="dsection">
            <span className="eyebrow">Environment access</span>
            <div className="acc-list">
              {envs.map(([env, perm]) => (
                <div className="acc-row" key={env}>
                  <span className="acc-env">
                    <Icon name={env === 'production' ? 'globe' : 'layers'} size={14} />{env}
                  </span>
                  <span className={`acc-perm ${perm}`}>{PERM_TXT[perm]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dsection">
            <span className="eyebrow">Permissions</span>
            <div className="caps">
              {CAP_GROUPS.map(g => (
                <div className="cap-group" key={g.group}>
                  <div className="cap-group-label">{g.group}</div>
                  {g.rows.map(row => (
                    <div className="cap-row" key={row.label}>
                      <span className="cap-name">{row.label}</span>
                      <CapVal state={role.caps ? (role.caps[row.label] || 'none') : row.vals[role.id]} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="dsection">
            <div className="dsection-head">
              <span className="eyebrow">Members</span>
              <span className="toolbar-meta mono">{people.length}</span>
            </div>
            {people.length > 0 ? (
              <div className="role-members">
                {people.map(m => (
                  <div className="rm-row" key={m.id}>
                    <span className={`uavatar ${m.role === 'owner' ? 'is-owner' : ''}`}>{m.initials}</span>
                    <span className="member-text">
                      <span className="member-name">{m.name}</span>
                      <span className="member-email mono">{m.email}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="role-empty">No members assigned yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { RolesPage, RoleDetail, ROLES, ROLE_ENV, CAP_GROUPS, PERM_TXT, CAP_STATE, roleName, roleDesc });

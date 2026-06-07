/* global React, Icon, Btn, Badge, Dot */
const { useState: useMState } = React;

const ROLE_META = {
  owner:      { icon: 'crown',        label: 'Owner',      desc: 'Full control of the organization, billing, and every environment.' },
  admin:      { icon: 'shield',       label: 'Admin',      desc: 'Manage members, roles, and infrastructure across assigned environments.' },
  maintainer: { icon: 'wrench',       label: 'Maintainer', desc: 'Deploy, start, stop, and prune resources. No member or billing access.' },
  developer:  { icon: 'code',         label: 'Developer',  desc: 'Build images and manage containers in non-production environments.' },
  viewer:     { icon: 'eye',          label: 'Viewer',     desc: 'Read-only access to containers, images, and logs.' },
  billing:    { icon: 'credit-card',  label: 'Billing',    desc: 'View invoices, seats, and usage. No infrastructure access.' },
};

const MEMBERS = [
  { id: 'u_jordan', name: 'Jordan Silva',  email: 'jordan@acme.io',       initials: 'JS', role: 'owner',      scopes: ['all'],                 twofa: true,  auth: 'SSO · Okta', last: '2m ago',  status: 'active',    tone: 'running', you: true,  since: 'Jan 2024' },
  { id: 'u_hana',   name: 'Hana Sato',     email: 'hana@acme.io',         initials: 'HS', role: 'admin',      scopes: ['all'],                 twofa: true,  auth: 'SSO · Okta', last: '12m ago', status: 'active',    tone: 'running', since: 'Feb 2024' },
  { id: 'u_mara',   name: 'Mara Chen',     email: 'mara@acme.io',         initials: 'MC', role: 'admin',      scopes: ['production','staging'],twofa: true,  auth: 'SSO · Okta', last: '18m ago', status: 'active',    tone: 'running', since: 'Mar 2024' },
  { id: 'u_devon',  name: 'Devon Okoro',   email: 'devon@acme.io',        initials: 'DO', role: 'maintainer', scopes: ['production'],          twofa: true,  auth: 'SSO · Okta', last: '1h ago',  status: 'active',    tone: 'running', since: 'May 2024' },
  { id: 'u_tomas',  name: 'Tomas Berg',    email: 'tomas@acme.io',        initials: 'TB', role: 'maintainer', scopes: ['staging'],             twofa: true,  auth: 'SSO · Okta', last: '26m ago', status: 'active',    tone: 'running', since: 'Jun 2024' },
  { id: 'u_priya',  name: 'Priya Nair',    email: 'priya@acme.io',        initials: 'PN', role: 'developer',  scopes: ['staging','dev'],       twofa: true,  auth: 'SSO · Okta', last: '3h ago',  status: 'active',    tone: 'running', since: 'Aug 2024' },
  { id: 'u_sofia',  name: 'Sofia Rossi',   email: 'sofia@acme.io',        initials: 'SR', role: 'viewer',     scopes: ['production'],          twofa: true,  auth: 'SSO · Okta', last: '5h ago',  status: 'active',    tone: 'running', since: 'Sep 2024' },
  { id: 'u_marcus', name: 'Marcus Lee',    email: 'marcus@acme.io',       initials: 'ML', role: 'viewer',     scopes: ['production'],          twofa: true,  auth: 'password',   last: '8d ago',  status: 'active',    tone: 'running', since: 'Oct 2024' },
  { id: 'u_aisha',  name: 'Aisha Khan',    email: 'aisha@acme.io',        initials: 'AK', role: 'billing',    scopes: [],                      twofa: true,  auth: 'SSO · Okta', last: '4d ago',  status: 'active',    tone: 'running', since: 'Apr 2024' },
  { id: 'u_liam',   name: 'Liam Novak',    email: 'liam@acme.io',         initials: 'LN', role: 'developer',  scopes: ['dev'],                 twofa: false, auth: 'password',   last: '2d ago',  status: 'active',    tone: 'running', since: 'Nov 2024' },
  { id: 'u_noah',   name: 'Noah Webb',     email: 'noah@contractor.dev',  initials: 'NW', role: 'developer',  scopes: ['dev'],                 twofa: false, auth: 'invite pending', last: '—',  status: 'pending',   tone: 'warn',    since: 'invited 2d ago' },
  { id: 'u_elena',  name: 'Elena Petrova', email: 'elena@acme.io',        initials: 'EP', role: 'developer',  scopes: ['staging'],             twofa: false, auth: 'password',   last: '21d ago', status: 'suspended', tone: 'danger',  since: 'Jul 2024' },
];

const STATUS_LABEL = { active: 'Active', pending: 'Invited', suspended: 'Suspended' };

function Scopes({ scopes }) {
  if (scopes.includes('all')) return <span className="scopes"><span className="scope-tag all">all</span></span>;
  if (scopes.length === 0) return <span className="scope-more">—</span>;
  const shown = scopes.slice(0, 1);
  const extra = scopes.length - shown.length;
  return (
    <span className="scopes">
      {shown.map(s => <span key={s} className="scope-tag">{s}</span>)}
      {extra > 0 && <span className="scope-more">+{extra}</span>}
    </span>
  );
}

function MembersTable({ rows, selectedId, setSelectedId, filter, setFilter }) {
  const filtered = rows.filter(r => filter === 'all' || r.status === filter);
  const cols = '32px minmax(0,1fr) 104px 84px 50px 72px 86px 28px';

  const counts = {
    all: rows.length,
    active: rows.filter(r => r.status === 'active').length,
    pending: rows.filter(r => r.status === 'pending').length,
    suspended: rows.filter(r => r.status === 'suspended').length,
  };

  return (
    <div className="content-area">
      <div className="content-head">
        <div className="content-title-row">
          <h2 className="content-title">Members</h2>
          <span className="content-count mono">{filtered.length} of {rows.length}</span>
        </div>
        <div className="content-actions">
          <Btn variant="ghost" icon="list-filter">Filter</Btn>
          <Btn variant="ghost" icon="arrow-up-down">Sort</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="download">Export</Btn>
          <Btn variant="primary" icon="user-plus">Invite member</Btn>
        </div>
      </div>

      <div className="content-toolbar">
        <div className="pills">
          {[
            { id: 'all',       label: 'All' },
            { id: 'active',    label: 'Active' },
            { id: 'pending',   label: 'Invited' },
            { id: 'suspended', label: 'Suspended' },
          ].map(f => (
            <button key={f.id} className={`pill ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}<span className="pill-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-meta mono">12 of 15 seats used · 3 available</div>
      </div>

      <div className="gtable members-table">
        <div className="gtable-head" style={{ gridTemplateColumns: cols }}>
          <span><input type="checkbox" /></span>
          <span>Member</span>
          <span>Role</span>
          <span>Access</span>
          <span>2FA</span>
          <span>Last active</span>
          <span>Status</span>
          <span></span>
        </div>
        {filtered.map(m => {
          const rm = ROLE_META[m.role];
          return (
            <div
              key={m.id}
              className={`gtable-row member-row is-${m.status} ${selectedId === m.id ? 'sel' : ''}`}
              style={{ gridTemplateColumns: cols }}
              onClick={() => setSelectedId(m.id)}
            >
              <span onClick={e => e.stopPropagation()}><input type="checkbox" /></span>
              <span className="member">
                <span className={`uavatar ${m.role === 'owner' ? 'is-owner' : ''} ${m.status === 'pending' ? 'is-pending' : ''}`}>{m.initials}</span>
                <span className="member-text">
                  <span className="member-name">{m.name}{m.you && <span className="you">you</span>}</span>
                  <span className="member-email mono">{m.email}</span>
                </span>
              </span>
              <span className={`role ${m.role}`}>
                <Icon name={rm.icon} size={14} />
                {rm.label}
              </span>
              <span><Scopes scopes={m.scopes} /></span>
              <span>
                {m.twofa
                  ? <span className="twofa on"><Icon name="shield-check" size={13} />on</span>
                  : <span className="twofa off"><Icon name="shield-off" size={13} />off</span>}
              </span>
              <span className="mono" style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{m.last}</span>
              <span><Badge tone={m.tone}>{STATUS_LABEL[m.status]}</Badge></span>
              <span onClick={e => e.stopPropagation()}>
                <button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { MembersTable, MEMBERS, ROLE_META, STATUS_LABEL });

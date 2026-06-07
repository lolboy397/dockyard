/* global React, Icon, Btn, Badge, Dot, ROLE_META, STATUS_LABEL */
const { useState: useDState } = React;

const ENV_ACCESS = {
  owner:      [['production','deploy'],['staging','deploy'],['dev','deploy']],
  admin:      [['production','write'],['staging','write'],['dev','write']],
  maintainer: [['production','deploy'],['staging','read'],['dev','read']],
  developer:  [['production','none'],['staging','write'],['dev','deploy']],
  viewer:     [['production','read'],['staging','read'],['dev','read']],
  billing:    [['production','none'],['staging','none'],['dev','none']],
};
const PERM_LABEL = { deploy: 'deploy', write: 'write', read: 'read', none: 'no access' };

const ACTIVITY = {
  u_jordan: [
    { rail: 'running', icon: 'rocket', text: <>deployed <span className="obj">api-prod</span> to production</>, meta: '2026.05.12 · 6 services', ts: '2m ago' },
    { rail: 'info',    icon: 'user-plus', text: <>invited <span className="obj">noah@contractor.dev</span> as developer</>, meta: 'dev environment', ts: '2d ago' },
    { rail: 'warn',    icon: 'shield',  text: <>changed role for <span className="obj">Elena Petrova</span></>, meta: 'developer → suspended', ts: '21d ago' },
    { rail: 'running', icon: 'key-round', text: <>rotated <span className="obj">registry-prod</span> token</>, meta: 'api.dockyard.io', ts: '24d ago' },
    { rail: 'idle',    icon: 'log-in',  text: <>signed in from a new device</>, meta: 'macOS · Safari · SF', ts: '26d ago' },
  ],
};
const DEFAULT_ACTIVITY = [
  { rail: 'running', icon: 'box',     text: <>started <span className="obj">worker-jobs</span></>, meta: 'staging', ts: '1h ago' },
  { rail: 'info',    icon: 'hammer',  text: <>built <span className="obj">internal/web:2026.05</span></>, meta: '94 MB · 9 layers', ts: '5h ago' },
  { rail: 'idle',    icon: 'log-in',  text: <>signed in</>, meta: 'macOS · Chrome', ts: '1d ago' },
];

const SESSIONS = [
  { icon: 'monitor',    dev: 'macOS · Chrome 126',  loc: 'San Francisco, US · 73.21.x.x', seen: 'active now', current: true },
  { icon: 'smartphone', dev: 'iOS · Dockyard app',  loc: 'San Francisco, US · 73.21.x.x', seen: '3h ago', current: false },
  { icon: 'terminal',   dev: 'CLI · dockyard/2.1.0', loc: 'CI runner · 10.0.4.x', seen: '1d ago', current: false },
];

function Field({ k, v, mono }) {
  return (<>
    <div className="meta-k">{k}</div>
    <div className="meta-v" style={mono ? { fontFamily: 'var(--font-mono)' } : null}>{v}</div>
  </>);
}

function MemberDetail({ member, onClose, onEdit }) {
  const [tab, setTab] = useDState('profile');
  if (!member) return null;
  const rm = ROLE_META[member.role];
  const envs = ENV_ACCESS[member.role] || [];
  const activity = ACTIVITY[member.id] || DEFAULT_ACTIVITY;

  const tabs = [
    { id: 'profile',  label: 'Profile' },
    { id: 'access',   label: 'Access' },
    { id: 'activity', label: 'Activity' },
    { id: 'sessions', label: 'Sessions' },
  ];

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-id">
          <span className={`uavatar lg ${member.role === 'owner' ? 'is-owner' : ''} ${member.status === 'pending' ? 'is-pending' : ''}`}>{member.initials}</span>
          <div className="member-text">
            <span className="detail-eyebrow">Member</span>
            <span className="detail-title">{member.name}</span>
            <span className="detail-sub">{member.email}</span>
          </div>
        </div>
        <div className="detail-head-actions">
          <Btn variant="ghost" size="sm" icon="pencil" onClick={onEdit}>Edit</Btn>
          <button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button>
          <button className="icon-btn ghost sm" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
      </div>

      <div className="detail-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`dtab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="detail-body">
        {tab === 'profile' && (
          <div className="dbody">
            <div className={`role-banner ${member.role === 'owner' ? 'owner' : ''}`}>
              <span className="ic-wrap"><Icon name={rm.icon} size={17} /></span>
              <div className="role-banner-text">
                <div className="role-banner-title">{rm.label}</div>
                <div className="role-banner-desc">{rm.desc}</div>
              </div>
            </div>

            <div className="dsection">
              <span className="eyebrow">Account</span>
              <div className="meta-grid">
                <Field k="Status" v={<Badge tone={member.tone}>{STATUS_LABEL[member.status]}</Badge>} />
                <Field k="Email" v={member.email} mono />
                <Field k="Member since" v={member.since} />
                <Field k="Last active" v={member.last} mono />
                <Field k="Auth method" v={member.auth} mono />
                <Field k="2FA" v={member.twofa
                  ? <span className="twofa on"><Icon name="shield-check" size={13} />enabled</span>
                  : <span className="twofa off"><Icon name="shield-off" size={13} />not enabled</span>} />
                <Field k="User ID" v={member.id} mono />
              </div>
            </div>

            {!member.twofa && member.status === 'active' && (
              <div className="dsection">
                <div className="acc-list">
                  <div className="acc-row">
                    <span className="acc-env"><Icon name="shield-alert" size={14} color="var(--warn-400)" />Two-factor authentication is off</span>
                    <Btn variant="secondary" size="sm">Require 2FA</Btn>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'access' && (
          <div className="dbody">
            <div className="dsection">
              <div className="dsection-head">
                <span className="eyebrow">Environment access</span>
                <span className="toolbar-meta mono">{rm.label}</span>
              </div>
              <div className="acc-list">
                {envs.map(([env, perm]) => (
                  <div className="acc-row" key={env}>
                    <span className="acc-env">
                      <Icon name={env === 'production' ? 'globe' : 'layers'} size={14} />
                      {env}
                    </span>
                    <span className={`acc-perm ${perm}`}>{PERM_LABEL[perm]}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="dsection">
              <span className="eyebrow">Capabilities</span>
              <div className="meta-grid">
                <Field k="Manage members" v={member.role === 'owner' || member.role === 'admin' ? 'Yes' : 'No'} />
                <Field k="Manage billing" v={member.role === 'owner' || member.role === 'billing' ? 'Yes' : 'No'} />
                <Field k="Deploy & restart" v={['owner','maintainer','developer'].includes(member.role) ? 'Yes' : 'No'} />
                <Field k="View logs" v={member.role === 'billing' ? 'No' : 'Yes'} />
                <Field k="Prune resources" v={['owner','admin','maintainer'].includes(member.role) ? 'Yes' : 'No'} />
              </div>
            </div>
          </div>
        )}

        {tab === 'activity' && (
          <div className="dbody">
            <div className="dsection">
              <div className="dsection-head">
                <span className="eyebrow">Recent activity</span>
                <span className="toolbar-meta mono">last 30 days</span>
              </div>
              <div className="activity">
                {activity.map((a, i) => (
                  <div className="act-row" key={i}>
                    <span className={`act-rail ${a.rail}`}><Icon name={a.icon} size={13} /></span>
                    <span className="act-text">{a.text}<span className="act-meta">{a.meta}</span></span>
                    <span className="act-ts">{a.ts}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'sessions' && (
          <div className="dbody">
            <div className="dsection">
              <div className="dsection-head">
                <span className="eyebrow">Active sessions</span>
                <Btn variant="ghost" size="sm" icon="log-out">Revoke all</Btn>
              </div>
              <div className="sess">
                {SESSIONS.map((s, i) => (
                  <div className={`sess-card ${s.current ? 'current' : ''}`} key={i}>
                    <span className="sess-ic"><Icon name={s.icon} size={15} /></span>
                    <div>
                      <div className="sess-dev">{s.dev}</div>
                      <div className="sess-loc">{s.loc}</div>
                    </div>
                    <div className="sess-right">
                      {s.current
                        ? <span className="sess-now">this device</span>
                        : <span className="sess-seen">{s.seen}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { MemberDetail, ENV_ACCESS, PERM_LABEL });

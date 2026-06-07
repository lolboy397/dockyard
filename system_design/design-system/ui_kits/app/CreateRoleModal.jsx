/* global React, Icon, Btn, ROLES, ROLE_ENV, CAP_GROUPS, roleName */
const { useState: useCRState, useEffect: useCREffect } = React;

const CR_ENVS = ['production', 'staging', 'dev'];
const CR_ENV_PERMS = ['none', 'read', 'write', 'deploy'];
const CR_CAP_STATES = [
  { v: 'none',   l: 'none' },
  { v: 'read',   l: 'read' },
  { v: 'scoped', l: 'scoped' },
  { v: 'all',    l: 'full' },
];
const CR_ICONS = ['shield-check', 'siren', 'wrench', 'rocket', 'terminal', 'bell-ring', 'eye', 'key-round'];
const CR_TEMPLATES = ['viewer', 'developer', 'maintainer', 'admin'];

function flatCaps() {
  const out = [];
  CAP_GROUPS.forEach(g => g.rows.forEach(r => out.push(r.label)));
  return out;
}

function envFromRole(roleId) {
  const out = {};
  CR_ENVS.forEach(e => { out[e] = 'none'; });
  (ROLE_ENV[roleId] || []).forEach(([e, p]) => { out[e] = p; });
  return out;
}
function capsFromRole(roleId) {
  const out = {};
  CAP_GROUPS.forEach(g => g.rows.forEach(r => { out[r.label] = roleId ? (r.vals[roleId] || 'none') : 'none'; }));
  return out;
}

function summarize(env) {
  const has = CR_ENVS.filter(e => env[e] !== 'none');
  if (has.length === 0) return 'No access';
  if (has.length === 3) return 'All environments';
  return has.join(', ');
}
function levelOf(caps) {
  const vals = Object.values(caps);
  const has = s => vals.includes(s);
  if (caps['Manage roles'] === 'all' || caps['Manage billing'] === 'all') return 'Manage + deploy';
  if (['all', 'scoped'].includes(caps['Deploy & rollback'])) return 'Operate + deploy';
  if (has('all') || has('scoped')) return 'Build + operate';
  if (has('read')) return 'Read-only';
  return 'No access';
}

function CRSwitchSeg({ options, value, onPick, accentValue }) {
  return (
    <div className="seg seg-perm">
      {options.map(o => {
        const v = typeof o === 'string' ? o : o.v;
        const l = typeof o === 'string' ? o : o.l;
        const on = value === v;
        return (
          <button
            type="button"
            key={v}
            className={`seg-opt ${on ? 'on' : ''} ${on && v === accentValue ? 'accent' : ''}`}
            onClick={() => onPick(v)}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

function CreateRoleModal({ onClose, onCreate }) {
  const [name, setName] = useCRState('');
  const [desc, setDesc] = useCRState('');
  const [icon, setIcon] = useCRState('shield-check');
  const [base, setBase] = useCRState('none');
  const [env, setEnv] = useCRState(() => envFromRole(null));
  const [caps, setCaps] = useCRState(() => capsFromRole(null));

  useCREffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  function pickBase(roleId) {
    setBase(roleId);
    if (roleId === 'none') {
      setEnv(envFromRole(null));
      setCaps(capsFromRole(null));
    } else {
      setEnv(envFromRole(roleId));
      setCaps(capsFromRole(roleId));
    }
  }

  function handleCreate() {
    const label = name.trim();
    if (!label) return;
    const id = 'custom_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    onCreate({
      id,
      icon,
      type: 'custom',
      members: 0,
      label,
      desc: desc.trim() || 'Custom role.',
      envSummary: summarize(env),
      level: levelOf(caps),
      env: CR_ENVS.map(e => [e, env[e]]),
      caps: { ...caps },
    });
  }

  const valid = name.trim().length > 0;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-lg" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="role-ic custom"><Icon name={icon} size={16} /></span>
          <div className="modal-title-wrap">
            <span className="modal-eyebrow">New role</span>
            <div className="modal-title">{name.trim() || 'Untitled role'}</div>
            <div className="modal-sub mono">custom role</div>
          </div>
          <button className="icon-btn ghost sm" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>

        <div className="modal-body">
          {/* DETAILS */}
          <div className="form-section">
            <div className="field">
              <span className="form-label">Role name</span>
              <input
                className="text-input"
                placeholder="e.g. On-call SRE"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <span className="form-label">Description</span>
              <textarea
                className="text-input"
                placeholder="What can people with this role do?"
                value={desc}
                onChange={e => setDesc(e.target.value)}
                rows={2}
              />
            </div>
            <div className="field">
              <span className="form-label">Icon</span>
              <div className="icon-pick">
                {CR_ICONS.map(ic => (
                  <button type="button" key={ic} className={`icon-opt ${icon === ic ? 'on' : ''}`} onClick={() => setIcon(ic)}>
                    <Icon name={ic} size={16} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* TEMPLATE */}
          <div className="form-section">
            <span className="form-label">Start from</span>
            <div className="tmpl-row">
              <button type="button" className={`tmpl-chip ${base === 'none' ? 'on' : ''}`} onClick={() => pickBase('none')}>
                <Icon name="circle-dashed" size={13} />Blank
              </button>
              {CR_TEMPLATES.map(rid => {
                const r = ROLES.find(x => x.id === rid);
                return (
                  <button type="button" key={rid} className={`tmpl-chip ${base === rid ? 'on' : ''}`} onClick={() => pickBase(rid)}>
                    <Icon name={r.icon} size={13} />{roleName(r)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ENVIRONMENT ACCESS */}
          <div className="form-section">
            <span className="form-label">Environment access</span>
            <div className="env-edit">
              {CR_ENVS.map(e => (
                <div className="env-edit-row" key={e}>
                  <span className="env-edit-name"><Icon name={e === 'production' ? 'globe' : 'layers'} size={14} />{e}</span>
                  <CRSwitchSeg options={CR_ENV_PERMS} value={env[e]} onPick={v => setEnv(p => ({ ...p, [e]: v }))} accentValue="deploy" />
                </div>
              ))}
            </div>
          </div>

          {/* PERMISSIONS */}
          <div className="form-section">
            <span className="form-label">Permissions</span>
            <div className="caps">
              {CAP_GROUPS.map(g => (
                <div className="cap-group" key={g.group}>
                  <div className="cap-group-label">{g.group}</div>
                  {g.rows.map(row => (
                    <div className="cap-edit-row" key={row.label}>
                      <span className="cap-edit-name">{row.label}</span>
                      <CRSwitchSeg
                        options={CR_CAP_STATES}
                        value={caps[row.label]}
                        onPick={v => setCaps(c => ({ ...c, [row.label]: v }))}
                        accentValue="all"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span className="foot-hint mono">creates a custom role · 0 members</span>
          <div className="foot-right">
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" icon="check" onClick={handleCreate} className={valid ? '' : 'is-disabled'}>Create role</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CreateRoleModal });

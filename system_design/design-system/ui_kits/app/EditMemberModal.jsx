/* global React, Icon, Btn, Badge, ROLE_META, ENV_ACCESS, PERM_LABEL, STATUS_LABEL */
const { useState: useEMState, useEffect: useEMEffect } = React;

const ROLE_ORDER = ['owner', 'admin', 'maintainer', 'developer', 'viewer', 'billing'];
const ENVS = ['production', 'staging', 'dev'];
const PERMS = ['none', 'read', 'write', 'deploy'];
const PERM_SHORT = { none: 'none', read: 'read', write: 'write', deploy: 'deploy' };

function permsFromRole(role) {
  const out = {};
  (ENV_ACCESS[role] || []).forEach(([env, perm]) => { out[env] = perm; });
  ENVS.forEach(e => { if (!(e in out)) out[e] = 'none'; });
  return out;
}

function Switch({ on, onClick }) {
  return <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} />;
}

function EditMemberModal({ member, onClose, onSave }) {
  const [role, setRole] = useEMState(member.role);
  const [perms, setPerms] = useEMState(() => permsFromRole(member.role));
  const [status, setStatus] = useEMState(member.status === 'suspended' ? 'suspended' : 'active');
  const [twofa, setTwofa] = useEMState(member.twofa);

  useEMEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  function pickRole(r) {
    setRole(r);
    setPerms(permsFromRole(r)); // changing role resets recommended access
  }

  function setEnvPerm(env, perm) {
    setPerms(p => ({ ...p, [env]: perm }));
  }

  function handleSave() {
    const accessEnvs = ENVS.filter(e => perms[e] !== 'none');
    const scopes = role === 'owner' ? ['all'] : accessEnvs;
    const tone = status === 'suspended' ? 'danger' : (member.status === 'pending' ? 'warn' : 'running');
    onSave({ ...member, role, scopes, twofa, status, tone });
  }

  const rm = ROLE_META[role];
  const dirty =
    role !== member.role ||
    status !== (member.status === 'suspended' ? 'suspended' : 'active') ||
    twofa !== member.twofa ||
    ENVS.some(e => perms[e] !== permsFromRole(member.role)[e]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className={`uavatar ${member.role === 'owner' ? 'is-owner' : ''}`}>{member.initials}</span>
          <div className="modal-title-wrap">
            <span className="modal-eyebrow">Edit member</span>
            <div className="modal-title">{member.name}</div>
            <div className="modal-sub mono">{member.email}</div>
          </div>
          <button className="icon-btn ghost sm" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>

        <div className="modal-body">
          {/* ROLE */}
          <div className="form-section">
            <span className="form-label">Role</span>
            <div className="role-grid">
              {ROLE_ORDER.map(r => {
                const m = ROLE_META[r];
                return (
                  <button type="button" key={r} className={`role-card ${role === r ? 'on' : ''}`} onClick={() => pickRole(r)}>
                    <Icon name={m.icon} size={15} />
                    <span className="role-card-label">{m.label}</span>
                    {role === r && <Icon name="check" size={13} className="role-check" />}
                  </button>
                );
              })}
            </div>
            <p className="role-desc">{rm.desc}</p>
          </div>

          {/* ENVIRONMENT ACCESS */}
          <div className="form-section">
            <div className="form-label-row">
              <span className="form-label">Environment access</span>
              <button type="button" className="reset-link" onClick={() => setPerms(permsFromRole(role))}>Reset to role default</button>
            </div>
            <div className="env-edit">
              {ENVS.map(env => (
                <div className="env-edit-row" key={env}>
                  <span className="env-edit-name">
                    <Icon name={env === 'production' ? 'globe' : 'layers'} size={14} />{env}
                  </span>
                  <div className="seg">
                    {PERMS.map(p => (
                      <button
                        type="button"
                        key={p}
                        className={`seg-opt ${perms[env] === p ? 'on' : ''} ${perms[env] === p && p === 'deploy' ? 'accent' : ''}`}
                        onClick={() => setEnvPerm(env, p)}
                      >
                        {PERM_SHORT[p]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ACCOUNT */}
          <div className="form-section">
            <span className="form-label">Account</span>
            <div className="toggle-row">
              <div className="toggle-row-text">
                <div className="toggle-row-title">Require two-factor authentication</div>
                <div className="toggle-row-desc">User must set up 2FA before next sign-in.</div>
              </div>
              <Switch on={twofa} onClick={() => setTwofa(v => !v)} />
            </div>
            <div className="toggle-row">
              <div className="toggle-row-text">
                <div className="toggle-row-title">Account status</div>
                <div className="toggle-row-desc">Suspended members keep their settings but cannot sign in.</div>
              </div>
              <div className="seg seg-status">
                <button type="button" className={`seg-opt ${status === 'active' ? 'on running' : ''}`} onClick={() => setStatus('active')}>Active</button>
                <button type="button" className={`seg-opt ${status === 'suspended' ? 'on danger' : ''}`} onClick={() => setStatus('suspended')}>Suspended</button>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="remove-link"><Icon name="user-minus" size={13} />Remove from organization</button>
          <div className="foot-right">
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" icon="check" onClick={handleSave} className={dirty ? '' : 'is-disabled'}>Save changes</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { EditMemberModal });

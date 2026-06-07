/* global React, Icon, Brand, BrandMark, Field, TextInput, PasswordInput, CheckRow, Btn */
const { useState: useLoginState } = React;

function LoginScreen({ knownUser, onSignedIn }) {
  const [username, setUsername] = useLoginState(knownUser || '');
  const [password, setPassword] = useLoginState('');
  const [remember, setRemember] = useLoginState(true);
  const [loading, setLoading] = useLoginState(false);
  const [error, setError] = useLoginState(null);
  const [done, setDone] = useLoginState(false);

  const canSubmit = username.trim() && password.length > 0;

  const submit = () => {
    if (!canSubmit || loading) return;
    setError(null);
    setLoading(true);
    // fire a packet burst from the mesh node nearest the Sign in button
    const btn = document.querySelector('.login-card .btn-primary');
    if (btn && window.DockyardMesh) { const r = btn.getBoundingClientRect(); window.DockyardMesh.burst(r.left + r.width / 2, r.top + r.height / 2, 7); }
    setTimeout(() => {
      // demo: anything works, except a deliberately wrong sentinel
      if (password === 'wrong') {
        setLoading(false);
        setError('Invalid username or password.');
        return;
      }
      setLoading(false);
      setDone(true);
      onSignedIn && onSignedIn(username);
    }, 1100);
  };

  if (done) {
    return (
      <div className="login fade-up">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <div className="login-brand">
            <span className="finish-mark" style={{ marginBottom: 4 }}><Icon name="check" size={28} strokeWidth={2.5} /></span>
          </div>
          <div className="login-title">Signed in</div>
          <div className="login-sub">Welcome back, {username}. Loading your dashboard…</div>
          <div className="finish-bar" style={{ margin: '22px auto 4px' }}><div className="finish-bar-fill" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="login fade-up">
      <div className="login-card">
        <div className="login-brand">
          <Brand size="lg" />
          <div style={{ textAlign: 'center' }}>
            <div className="login-title">Sign in</div>
            <div className="login-sub">Authenticate to manage this instance.</div>
          </div>
        </div>

        <div className="login-form">
          <Field label="Username">
            <TextInput value={username} onChange={v => { setUsername(v); setError(null); }} placeholder="admin" icon="user" mono autoFocus={!knownUser} onEnter={submit} />
          </Field>

          <Field label="Password" error={error}>
            <PasswordInput value={password} onChange={v => { setPassword(v); setError(null); }} placeholder="Enter your password" err={!!error} autoFocus={!!knownUser} onEnter={submit} />
          </Field>

          <div className="login-row-between">
            <CheckRow on={remember} onClick={() => setRemember(r => !r)}>Keep me signed in</CheckRow>
            <span className="login-link">Forgot password?</span>
          </div>

          <Btn variant="primary" block icon={loading ? null : 'log-in'} loading={loading} onClick={submit} disabled={!canSubmit}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Btn>
        </div>

        <div className="login-foot">
          <span className="eyebrow-dot" />
          <span>localhost:9443</span>
          <span className="sep">·</span>
          <span>engine 26.1.4</span>
          <span className="sep">·</span>
          <span>v2.1.0</span>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
          Self-hosted Dockyard.
          <span className="login-link" style={{ marginLeft: 5 }}>Switch instance</span>
        </span>
      </div>
    </div>
  );
}

Object.assign(window, { LoginScreen });

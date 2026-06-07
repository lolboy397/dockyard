/* global React, Icon, BrandMark, Brand, Field, TextInput, PasswordInput, PasswordStrength, scorePassword, Toggle, CheckRow, Btn */
const { useState: useSetupState, useEffect: useSetupEffect } = React;

const STEPS = [
  { id: 'welcome',  label: 'Welcome' },
  { id: 'admin',    label: 'Admin account' },
  { id: 'instance', label: 'Instance' },
  { id: 'prefs',    label: 'Preferences' },
  { id: 'review',   label: 'Review' },
];

function SetupWizard({ data, setData, onFinish }) {
  const [stepIdx, setStepIdx] = useSetupState(0);
  const [maxReached, setMaxReached] = useSetupState(0);
  const [finishing, setFinishing] = useSetupState(false);
  const step = STEPS[stepIdx];

  const set = (patch) => setData(d => ({ ...d, ...patch }));

  const go = (i) => {
    setStepIdx(i);
    setMaxReached(m => Math.max(m, i));
  };
  const next = () => go(Math.min(stepIdx + 1, STEPS.length - 1));
  const back = () => go(Math.max(stepIdx - 1, 0));

  // per-step validity gate
  const pw = scorePassword(data.password);
  const valid = {
    welcome: data.accepted,
    admin: data.fullName.trim() && /\S+@\S+\.\S+/.test(data.email) && data.username.trim().length >= 3
           && pw.score >= 3 && data.password === data.confirm,
    instance: data.instanceName.trim() && data.dockerHost.trim(),
    prefs: true,
    review: true,
  }[step.id];

  const doFinish = () => {
    setFinishing(true);
    const btn = document.querySelector('.setup-foot .btn-primary');
    if (btn && window.DockyardMesh) { const r = btn.getBoundingClientRect(); window.DockyardMesh.burst(r.left + r.width / 2, r.top + r.height / 2, 8); }
    setTimeout(() => onFinish(), 1800);
  };

  const progress = ((stepIdx) / (STEPS.length - 1)) * 100;

  return (
    <div className="setup fade-up">
      {/* ---- left rail ---- */}
      <aside className="setup-rail">
        <div className="rail-brand">
          <BrandMark size={26} />
          <span className="brand-word">Dockyard</span>
          <span className="rail-tag">setup</span>
        </div>
        <p className="rail-lede">Configure this instance. Takes about two minutes — you can change everything later in settings.</p>

        <div className="steps">
          {STEPS.map((s, i) => {
            const state = i === stepIdx ? 'on' : i < maxReached || (i < stepIdx) ? 'done' : '';
            const done = i < stepIdx;
            const clickable = i <= maxReached;
            return (
              <React.Fragment key={s.id}>
                <div className={`step ${i === stepIdx ? 'on' : ''} ${done ? 'done' : ''} ${clickable ? 'clickable' : ''}`}
                     onClick={() => clickable && go(i)}>
                  <span className="step-num">{done ? <Icon name="check" size={13} strokeWidth={2.5} /> : i + 1}</span>
                  <span className="step-label">{s.label}</span>
                </div>
                {i < STEPS.length - 1 && <span className="step-connector" />}
              </React.Fragment>
            );
          })}
        </div>

        <div className="rail-foot">
          <div className="rail-host">
            <span className="eyebrow-dot" />
            <span>localhost · engine 26.1.4</span>
          </div>
        </div>
      </aside>

      {/* ---- right content ---- */}
      <div className="setup-main">
        <div className="setup-progress"><div className="setup-progress-bar" style={{ width: `${progress}%` }} /></div>

        <div className="setup-body" key={step.id}>
          {step.id === 'welcome'  && <StepWelcome data={data} set={set} />}
          {step.id === 'admin'    && <StepAdmin data={data} set={set} pw={pw} />}
          {step.id === 'instance' && <StepInstance data={data} set={set} />}
          {step.id === 'prefs'    && <StepPrefs data={data} set={set} />}
          {step.id === 'review'   && <StepReview data={data} goTo={go} />}
        </div>

        <div className="setup-foot">
          <span className="foot-meta">step {stepIdx + 1} of {STEPS.length}</span>
          <div className="foot-actions">
            {stepIdx > 0 && <Btn variant="ghost" icon="arrow-left" onClick={back}>Back</Btn>}
            {step.id === 'review'
              ? <Btn variant="primary" icon="check" onClick={doFinish} loading={finishing}>Create admin &amp; finish</Btn>
              : <Btn variant="primary" iconRight="arrow-right" onClick={next} disabled={!valid}>Continue</Btn>}
          </div>
        </div>
      </div>

      {finishing && (
        <div className="finish">
          <span className="finish-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
          <div className="finish-title">Instance ready</div>
          <div className="finish-desc">Created admin <span className="mono" style={{ color: 'var(--fg-default)' }}>{data.username}</span> · taking you to sign in…</div>
          <div className="finish-bar"><div className="finish-bar-fill" /></div>
        </div>
      )}
    </div>
  );
}

/* ===================== STEPS ===================== */

function StepWelcome({ data, set }) {
  const features = [
    { ic: 'box', t: 'Manage your whole fleet', d: 'Containers, images, volumes and networks — across every host, in one place.' },
    { ic: 'shield-check', t: 'Self-hosted & private', d: 'Runs entirely on your infrastructure. Your data never leaves this machine.' },
    { ic: 'terminal', t: 'Built for the terminal', d: 'Keyboard-first, mono-comfortable, and fast. The docker manager you’d actually pay for.' },
  ];
  return (
    <div className="welcome">
      <div className="welcome-marks"><BrandMark size={34} /></div>
      <div className="setup-head" style={{ marginBottom: 18 }}>
        <div className="setup-eyebrow">First-run setup</div>
        <h1 className="setup-title">Welcome to Dockyard</h1>
        <p className="setup-desc">You’re setting up a new local instance. First, let’s create your admin account and point Dockyard at your Docker engine.</p>
      </div>

      <div className="welcome-feature-list">
        {features.map(f => (
          <div className="wf" key={f.t}>
            <span className="wf-ic"><Icon name={f.ic} size={17} /></span>
            <div className="wf-text">
              <div className="t">{f.t}</div>
              <div className="d">{f.d}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px solid var(--border-subtle)', width: '100%' }}>
        <CheckRow on={data.accepted} onClick={() => set({ accepted: !data.accepted })}>
          I agree to the <a href="#" onClick={e => e.preventDefault()}>terms of service</a> and <a href="#" onClick={e => e.preventDefault()}>privacy policy</a>.
        </CheckRow>
      </div>
    </div>
  );
}

function StepAdmin({ data, set, pw }) {
  const mismatch = data.confirm.length > 0 && data.confirm !== data.password;
  return (
    <div>
      <div className="setup-head">
        <div className="setup-eyebrow">Step 1 · Administrator</div>
        <h1 className="setup-title">Create the admin account</h1>
        <p className="setup-desc">This is the first and highest-privilege account. It can manage every container, user and setting on this instance.</p>
      </div>

      <div className="form-grid cols-2">
        <Field label="Full name">
          <TextInput value={data.fullName} onChange={v => set({ fullName: v })} placeholder="Mara Okafor" icon="user" autoFocus />
        </Field>
        <Field label="Email">
          <TextInput value={data.email} onChange={v => set({ email: v })} placeholder="mara@example.com" icon="mail" type="email" />
        </Field>
        <Field label="Username" hint="Lowercase, no spaces. Used to sign in." className="span-2">
          <TextInput value={data.username} onChange={v => set({ username: v.toLowerCase().replace(/\s/g, '') })} placeholder="admin" icon="at-sign" mono />
        </Field>

        <div className="span-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <Field label="Password">
            <PasswordInput value={data.password} onChange={v => set({ password: v })} placeholder="••••••••••" />
          </Field>
          <Field label="Confirm password" error={mismatch ? 'Passwords don’t match' : null}>
            <PasswordInput value={data.confirm} onChange={v => set({ confirm: v })} placeholder="••••••••••" err={mismatch} icon="lock-keyhole" />
          </Field>
        </div>
        <div className="span-2"><PasswordStrength value={data.password} /></div>
      </div>
    </div>
  );
}

function StepInstance({ data, set }) {
  const [testing, setTesting] = useSetupState(false);
  const [tested, setTested] = useSetupState(false);
  const runTest = () => {
    setTesting(true); setTested(false);
    setTimeout(() => { setTesting(false); setTested(true); }, 1100);
  };
  return (
    <div>
      <div className="setup-head">
        <div className="setup-eyebrow">Step 2 · Engine</div>
        <h1 className="setup-title">Connect your Docker engine</h1>
        <p className="setup-desc">Name this instance and tell Dockyard where the Docker daemon lives. Defaults work for a standard local install.</p>
      </div>

      <div className="form-grid">
        <Field label="Instance name" hint="Shown in the title bar and across multi-instance views.">
          <TextInput value={data.instanceName} onChange={v => set({ instanceName: v })} placeholder="production" icon="server" autoFocus />
        </Field>

        <Field label="Docker host" hint="Unix socket for a local daemon, or a tcp:// address for a remote one.">
          <TextInput value={data.dockerHost} onChange={v => set({ dockerHost: v })} placeholder="/var/run/docker.sock" prefix="unix://" mono />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <Field label="Data directory" hint="Where Dockyard stores its config & database.">
            <TextInput value={data.dataDir} onChange={v => set({ dataDir: v })} placeholder="/var/lib/dockyard" icon="folder" mono />
          </Field>
          <Field label="Bind address" hint="Host : port the web UI listens on.">
            <TextInput value={data.bindAddr} onChange={v => set({ bindAddr: v })} placeholder="0.0.0.0:9443" icon="globe" mono />
          </Field>
        </div>

        <div className="test-row">
          <Btn variant="secondary" icon="plug-zap" onClick={runTest} loading={testing}>Test connection</Btn>
          {tested && !testing && (
            <span className="test-result ok"><Icon name="check-circle-2" size={15} /> connected · 12 containers · 38 images</span>
          )}
        </div>
      </div>
    </div>
  );
}

function StepPrefs({ data, set }) {
  return (
    <div>
      <div className="setup-head">
        <div className="setup-eyebrow">Step 3 · Preferences</div>
        <h1 className="setup-title">Set your defaults</h1>
        <p className="setup-desc">A few instance-wide preferences. Every one of these can be changed later in settings.</p>
      </div>

      <div className="form-grid">
        <Toggle on={data.tls} onClick={() => set({ tls: !data.tls })}
          title="Require TLS"
          desc="Serve the UI over HTTPS with a self-signed certificate. Strongly recommended for any non-loopback bind address." />
        <Toggle on={data.autoUpdate} onClick={() => set({ autoUpdate: !data.autoUpdate })}
          title="Automatic updates"
          desc="Pull and apply Dockyard updates from the stable channel as they ship." />
        <Toggle on={data.telemetry} onClick={() => set({ telemetry: !data.telemetry })}
          title="Anonymous usage stats"
          desc="Share anonymized, aggregate usage to help prioritize features. No container data, ever. Off by default." />

        <Field label="Default registry" hint="Used when you pull an image without a registry prefix." optional>
          <TextInput value={data.registry} onChange={v => set({ registry: v })} placeholder="docker.io" icon="cloud" mono />
        </Field>
      </div>
    </div>
  );
}

function StepReview({ data, goTo }) {
  const pwMask = '•'.repeat(Math.max(8, data.password.length || 10));
  const onOff = (b) => b ? 'enabled' : 'disabled';
  return (
    <div>
      <div className="setup-head">
        <div className="setup-eyebrow">Step 4 · Review</div>
        <h1 className="setup-title">Confirm and create</h1>
        <p className="setup-desc">Double-check everything below. Creating the admin finalizes setup — you’ll sign in next.</p>
      </div>

      <div className="review-group">
        <div className="review-gh">
          <span className="t"><Icon name="user" size={14} color="var(--accent)" /> Admin account</span>
          <span className="review-edit" onClick={() => goTo(1)}><Icon name="pencil" size={12} /> Edit</span>
        </div>
        <div className="review-rows">
          <Row k="Full name" v={data.fullName || '—'} dim={!data.fullName} />
          <Row k="Email" v={data.email || '—'} dim={!data.email} />
          <Row k="Username" v={data.username || '—'} dim={!data.username} />
          <Row k="Password" v={pwMask} dim />
        </div>
      </div>

      <div className="review-group">
        <div className="review-gh">
          <span className="t"><Icon name="server" size={14} color="var(--accent)" /> Instance</span>
          <span className="review-edit" onClick={() => goTo(2)}><Icon name="pencil" size={12} /> Edit</span>
        </div>
        <div className="review-rows">
          <Row k="Name" v={data.instanceName || '—'} dim={!data.instanceName} />
          <Row k="Docker host" v={`unix://${data.dockerHost || '/var/run/docker.sock'}`} />
          <Row k="Data directory" v={data.dataDir || '/var/lib/dockyard'} />
          <Row k="Bind address" v={data.bindAddr || '0.0.0.0:9443'} />
        </div>
      </div>

      <div className="review-group">
        <div className="review-gh">
          <span className="t"><Icon name="sliders-horizontal" size={14} color="var(--accent)" /> Preferences</span>
          <span className="review-edit" onClick={() => goTo(3)}><Icon name="pencil" size={12} /> Edit</span>
        </div>
        <div className="review-rows">
          <Row k="TLS" v={onOff(data.tls)} dim={!data.tls} />
          <Row k="Auto updates" v={onOff(data.autoUpdate)} dim={!data.autoUpdate} />
          <Row k="Usage stats" v={onOff(data.telemetry)} dim={!data.telemetry} />
          <Row k="Default registry" v={data.registry || 'docker.io'} />
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, dim }) {
  return (
    <div className="review-row">
      <span className="review-k">{k}</span>
      <span className={`review-v ${dim ? 'dim' : ''}`}>{v}</span>
    </div>
  );
}

Object.assign(window, { SetupWizard });

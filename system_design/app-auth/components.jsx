/* global React */
const { useState, useRef, useLayoutEffect, useEffect } = React;

/* ---------- mesh-background hooks: light up the nearest container ---------- */
function meshFocus(e) {
  const r = e.target.getBoundingClientRect();
  if (window.DockyardMesh) window.DockyardMesh.setSource(r.left + r.width / 2, r.top + r.height / 2);
}
function meshBlur() { if (window.DockyardMesh) window.DockyardMesh.setSource(null); }

/* ---------- Icon — Lucide ---------- */
function Icon({ name, size = 16, strokeWidth = 1.5, color, style = {} }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (!ref.current || !window.lucide) return;
    ref.current.innerHTML = `<i data-lucide="${name}"></i>`;
    window.lucide.createIcons({ nameAttr: 'data-lucide', attrs: { width: size, height: size, 'stroke-width': strokeWidth } });
  }, [name, size, strokeWidth]);
  return <span ref={ref} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: 'none', color: color || 'currentColor', ...style }} />;
}

/* ---------- Brand mark — the cyan container glyph ---------- */
function BrandMark({ size = 26, className = '' }) {
  return (
    <svg className={`brand-mark ${className}`} width={size} height={size} viewBox="0 0 24 24" style={{ width: size, height: size }}>
      <rect x="2" y="4" width="20" height="16" rx="3" fill="#22D3EE" />
      <rect x="6" y="9" width="3" height="3" rx="0.5" fill="#04181D" />
      <rect x="10.5" y="9" width="3" height="3" rx="0.5" fill="#04181D" />
      <rect x="15" y="9" width="3" height="3" rx="0.5" fill="#04181D" />
      <rect x="6" y="13.5" width="3" height="3" rx="0.5" fill="#04181D" />
      <rect x="10.5" y="13.5" width="3" height="3" rx="0.5" fill="#04181D" />
    </svg>
  );
}

function Brand({ size = 'md' }) {
  const lg = size === 'lg';
  return (
    <div className="brand">
      <BrandMark size={lg ? 30 : 26} className={lg ? 'lg' : ''} />
      <span className={`brand-word ${lg ? 'lg' : ''}`}>Dockyard</span>
    </div>
  );
}

/* ---------- Text field ---------- */
function Field({ label, optional, hint, icon, error, children }) {
  return (
    <div className="field">
      {label && (
        <label className="field-label">
          <span>{label}</span>
          {optional && <span className="opt">optional</span>}
        </label>
      )}
      {children}
      {error
        ? <span className="field-error"><Icon name="alert-circle" size={12} /> {error}</span>
        : hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, icon, type = 'text', mono, prefix, trailTag, autoFocus, ok, err, onEnter }) {
  return (
    <div className={`input-wrap ${icon ? 'lead' : ''} ${ok ? 'ok' : ''} ${err ? 'err' : ''}`}>
      {prefix && <span className="input-prefix">{prefix}</span>}
      {icon && <span className="lead-ic"><Icon name={ok ? 'check' : icon} size={15} /></span>}
      <input
        type={type} value={value} placeholder={placeholder}
        className={mono ? 'mono' : ''} autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
        onFocus={meshFocus} onBlur={meshBlur}
        onKeyDown={e => { if (e.key === 'Enter' && onEnter) onEnter(); }}
      />
      {trailTag && <span className="trail-tag">{trailTag}</span>}
    </div>
  );
}

/* ---------- Password field with reveal ---------- */
function PasswordInput({ value, onChange, placeholder, autoFocus, err, onEnter, icon = 'lock' }) {
  const [show, setShow] = useState(false);
  return (
    <div className={`input-wrap lead ${err ? 'err' : ''}`}>
      <span className="lead-ic"><Icon name={icon} size={15} /></span>
      <input
        type={show ? 'text' : 'password'} value={value} placeholder={placeholder}
        autoFocus={autoFocus} onChange={e => onChange(e.target.value)}
        onFocus={meshFocus} onBlur={meshBlur}
        onKeyDown={e => { if (e.key === 'Enter' && onEnter) onEnter(); }}
      />
      <button className="trail-btn" type="button" tabIndex={-1} onClick={() => setShow(s => !s)} title={show ? 'Hide' : 'Show'}>
        <Icon name={show ? 'eye-off' : 'eye'} size={15} />
      </button>
    </div>
  );
}

/* ---------- Password strength ---------- */
function scorePassword(pw) {
  const reqs = {
    len: pw.length >= 10,
    upper: /[A-Z]/.test(pw),
    num: /[0-9]/.test(pw),
    sym: /[^A-Za-z0-9]/.test(pw),
  };
  const met = Object.values(reqs).filter(Boolean).length;
  return { reqs, met, score: pw.length === 0 ? 0 : met };
}

function PasswordStrength({ value }) {
  const { reqs, score } = scorePassword(value);
  const levels = [
    { label: '', color: 'var(--ink-4)' },
    { label: 'weak', color: 'var(--danger-500)' },
    { label: 'fair', color: 'var(--warn-500)' },
    { label: 'good', color: 'var(--warn-400)' },
    { label: 'strong', color: 'var(--running-500)' },
  ];
  const lvl = levels[score];
  return (
    <div style={{ marginTop: 6 }}>
      <div className="pw-meter">
        {[1, 2, 3, 4].map(i => (
          <span key={i} className="pw-seg" style={{ background: i <= score ? lvl.color : 'var(--ink-4)' }} />
        ))}
      </div>
      {value && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span className="pw-label" style={{ color: lvl.color }}>{lvl.label}</span>
        </div>
      )}
      <div className="pw-reqs">
        <Req met={reqs.len}>10+ characters</Req>
        <Req met={reqs.upper}>uppercase letter</Req>
        <Req met={reqs.num}>number</Req>
        <Req met={reqs.sym}>symbol</Req>
      </div>
    </div>
  );
}
function Req({ met, children }) {
  return (
    <span className={`pw-req ${met ? 'met' : ''}`}>
      <span className="rq-ic"><Icon name={met ? 'check-circle-2' : 'circle'} size={13} /></span>
      {children}
    </span>
  );
}

/* ---------- Toggle row ---------- */
function Toggle({ on, onClick, title, desc }) {
  return (
    <div className={`toggle-row ${on ? 'on' : ''}`} onClick={onClick}>
      <div className="toggle-text">
        <div className="toggle-title">{title}</div>
        {desc && <div className="toggle-desc">{desc}</div>}
      </div>
      <span className="switch" />
    </div>
  );
}

/* ---------- Checkbox row ---------- */
function CheckRow({ on, onClick, children }) {
  return (
    <div className={`check-row ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="cbox"><Icon name="check" size={12} strokeWidth={3} /></span>
      <span className="check-label">{children}</span>
    </div>
  );
}

/* ---------- Button ---------- */
function Btn({ children, variant = 'secondary', icon, iconRight, onClick, disabled, block, loading, type = 'button' }) {
  return (
    <button type={type} className={`btn btn-${variant} ${block ? 'btn-block' : ''}`} onClick={onClick} disabled={disabled || loading}>
      {loading ? <span className="spin"><Icon name="loader-2" size={15} /></span> : icon && <Icon name={icon} size={15} />}
      {children && <span>{children}</span>}
      {iconRight && !loading && <Icon name={iconRight} size={15} />}
    </button>
  );
}

Object.assign(window, {
  Icon, BrandMark, Brand, Field, TextInput, PasswordInput,
  PasswordStrength, scorePassword, Toggle, CheckRow, Btn,
});

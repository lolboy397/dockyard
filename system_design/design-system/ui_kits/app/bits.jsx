/* global React */
const { useState, useEffect, useRef, useLayoutEffect } = React;

/* ---------- Icon — Lucide via data-lucide ------------------------------ */
function Icon({ name, size = 16, color, className = '', style = {} }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (!ref.current || !window.lucide) return;
    // Reset and re-trigger lucide on our local node
    ref.current.innerHTML = `<i data-lucide="${name}"></i>`;
    window.lucide.createIcons({ nameAttr: 'data-lucide', attrs: { width: size, height: size, 'stroke-width': 1.5 } });
  }, [name, size]);
  return <span ref={ref} className={`ic ${className}`} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flex: 'none', color: color || 'currentColor', ...style }} />;
}

/* ---------- Button ----------------------------------------------------- */
function Btn({ children, variant = 'secondary', size = 'md', icon, iconRight, onClick, style = {}, className = '', title, active }) {
  return (
    <button title={title} className={`btn btn-${variant} btn-${size} ${active ? 'is-active' : ''} ${className}`} onClick={onClick} style={style}>
      {icon && <Icon name={icon} size={size === 'sm' ? 12 : 14} />}
      {children && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 12 : 14} />}
    </button>
  );
}

/* ---------- Dot -------------------------------------------------------- */
function Dot({ tone = 'idle', size = 6 }) {
  const c = { running: '#34D399', warn: '#FBBF24', danger: '#F87171', info: '#60A5FA', idle: '#94A3B8', accent: 'var(--accent)' }[tone] || tone;
  return <span style={{ width: size, height: size, borderRadius: 999, background: c, display: 'inline-block', flex: 'none' }} />;
}

/* ---------- Badge ------------------------------------------------------ */
function Badge({ tone = 'idle', children }) {
  const colors = {
    running: { bg: 'rgba(16,185,129,0.12)', fg: '#34D399' },
    warn:    { bg: 'rgba(245,158,11,0.12)', fg: '#FBBF24' },
    danger:  { bg: 'rgba(239,68,68,0.12)',  fg: '#F87171' },
    info:    { bg: 'rgba(59,130,246,0.12)', fg: '#60A5FA' },
    idle:    { bg: 'rgba(148,163,184,0.10)', fg: '#94A3B8' },
  }[tone];
  return (
    <span className="badge" style={{ background: colors.bg, color: colors.fg }}>
      <Dot tone={tone} /> {children}
    </span>
  );
}

function Kbd({ children }) { return <kbd className="kbd">{children}</kbd>; }

function Chip({ children, active, onClick }) {
  return <span className={`chip ${active ? 'is-active' : ''}`} onClick={onClick}>{children}</span>;
}

Object.assign(window, { Icon, Btn, Dot, Badge, Kbd, Chip });

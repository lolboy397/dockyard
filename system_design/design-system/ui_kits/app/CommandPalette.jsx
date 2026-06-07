/* global React, Icon, Kbd */
const { useState: useCState, useEffect: useCEffect } = React;

function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useCState('');
  useCEffect(() => { if (open) setQuery(''); }, [open]);
  if (!open) return null;

  const cmds = [
    { icon: 'play',     label: 'Start nginx-prod',      scope: 'container', hot: ['⌘', '↵'] },
    { icon: 'square',   label: 'Stop nginx-prod',       scope: 'container' },
    { icon: 'rotate-ccw', label: 'Restart postgres-main', scope: 'container' },
    { icon: 'download', label: 'Pull nginx:1.27',       scope: 'image' },
    { icon: 'download', label: 'Pull postgres:16.3',    scope: 'image' },
    { icon: 'terminal', label: 'Open shell in worker-jobs', scope: 'container' },
    { icon: 'hammer',   label: 'Rebuild stack: production', scope: 'compose' },
    { icon: 'trash-2',  label: 'Prune unused images',   scope: 'system' },
  ].filter(c => c.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={e => e.stopPropagation()}>
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Type a command…" />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list">
          {cmds.length === 0 && <div className="palette-empty">No commands match.</div>}
          {cmds.map((c, i) => (
            <div key={i} className={`palette-row ${i === 0 ? 'on' : ''}`}>
              <Icon name={c.icon} size={14} />
              <span className="palette-label" dangerouslySetInnerHTML={{ __html: highlight(c.label, query) }} />
              <span className="palette-scope mono">{c.scope}</span>
              {c.hot && <span className="palette-hot">{c.hot.map((k, j) => <Kbd key={j}>{k}</Kbd>)}</span>}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span><Kbd>↵</Kbd> run</span>
          <span><Kbd>⌘</Kbd><Kbd>↵</Kbd> run + close</span>
        </div>
      </div>
    </div>
  );
}

function highlight(label, q) {
  if (!q) return label;
  const i = label.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return label;
  return label.slice(0, i) + `<mark>${label.slice(i, i + q.length)}</mark>` + label.slice(i + q.length);
}

Object.assign(window, { CommandPalette });

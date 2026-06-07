/* global React, Icon, Dot */

function AdminBrandMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24">
      <rect x="2" y="4" width="20" height="16" rx="3" fill="#22D3EE"/>
      <rect x="6" y="9" width="3" height="3" rx="0.5" fill="#04181D"/>
      <rect x="10.5" y="9" width="3" height="3" rx="0.5" fill="#04181D"/>
      <rect x="15" y="9" width="3" height="3" rx="0.5" fill="#04181D"/>
      <rect x="6" y="13.5" width="3" height="3" rx="0.5" fill="#04181D"/>
      <rect x="10.5" y="13.5" width="3" height="3" rx="0.5" fill="#04181D"/>
    </svg>
  );
}

function AdminSidebar({ section, onNavigate }) {
  // Mirrors the canonical app Sidebar (Overview / Workspace / Build / Observe)
  // exactly, then appends the Admin group this screen lives under.
  const groups = [
    {
      label: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
        { id: 'projects',  label: 'Projects',  icon: 'rocket', count: 6 },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { id: 'containers', label: 'Containers', icon: 'box',     count: 10 },
        { id: 'images',     label: 'Images',     icon: 'layers',  count: 38 },
        { id: 'volumes',    label: 'Volumes',    icon: 'database', count: 9 },
        { id: 'networks',   label: 'Networks',   icon: 'network',  count: 4 },
      ],
    },
    {
      label: 'Build',
      items: [
        { id: 'compose',  label: 'Compose',  icon: 'boxes' },
        { id: 'builds',   label: 'Builds',   icon: 'hammer' },
        { id: 'registry', label: 'Registry', icon: 'cloud' },
      ],
    },
    {
      label: 'Observe',
      items: [
        { id: 'logs',    label: 'Logs',    icon: 'scroll-text' },
        { id: 'metrics', label: 'Metrics', icon: 'activity' },
        { id: 'events',  label: 'Events',  icon: 'rss' },
      ],
    },
    {
      label: 'Admin',
      items: [
        { id: 'members', label: 'Members', icon: 'users', count: 12 },
        { id: 'roles',   label: 'Roles',   icon: 'shield' },
      ],
    },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark"><AdminBrandMark/></span>
          <span className="brand-word">Dockyard</span>
        </div>
        <button className="icon-btn ghost" title="Collapse"><Icon name="panel-left-close" size={14} /></button>
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={13} />
        <input placeholder="Quick find…" />
        <span className="kbd-mini">⌘K</span>
      </div>

      <nav className="sidebar-nav">
        {groups.map(g => (
          <div className="nav-group" key={g.label}>
            <div className="nav-group-label">{g.label}</div>
            {g.items.map(it => (
              <button
                key={it.id}
                className={`nav-item ${section === it.id ? 'on' : ''}`}
                onClick={() => onNavigate && onNavigate(it.id)}
              >
                <Icon name={it.icon} size={15} />
                <span className="nav-label">{it.label}</span>
                {it.count != null && <span className="nav-count">{it.count}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button className="env-switcher">
          <Dot tone="accent" />
          <div className="env-text">
            <div className="env-name">production</div>
            <div className="env-region">us-east-1 · 14 nodes</div>
          </div>
          <Icon name="chevrons-up-down" size={13} />
        </button>
      </div>
    </aside>
  );
}

Object.assign(window, { AdminSidebar });

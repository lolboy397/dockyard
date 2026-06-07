/* global React, Icon, Btn */

function TopBar({ onOpenPalette, crumb }) {
  return (
    <header className="topbar">
      <div className="crumbs">
        <span className="crumb">production</span>
        <Icon name="chevron-right" size={12} color="var(--fg-subtle)" />
        <span className="crumb on">{crumb || 'Containers'}</span>
      </div>

      <button className="palette-trigger" onClick={onOpenPalette}>
        <Icon name="search" size={13} />
        <span>Search containers, images, commands…</span>
        <span className="kbd-mini">⌘K</span>
      </button>

      <div className="topbar-right">
        <button className="icon-btn ghost" title="Activity"><Icon name="bell" size={14} /></button>
        <button className="icon-btn ghost" title="Help"><Icon name="circle-help" size={14} /></button>
        <div className="divider-v" />
        <div className="avatar">JS</div>
      </div>
    </header>
  );
}

Object.assign(window, { TopBar });

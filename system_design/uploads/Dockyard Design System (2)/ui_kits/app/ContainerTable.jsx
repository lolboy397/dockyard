/* global React, Icon, Btn, Badge, Chip, Dot */
const { useState: useTState } = React;

function ContainerTable({ rows, selectedId, setSelectedId, filter, setFilter }) {
  const filtered = rows.filter(r => filter === 'all' || r.statusGroup === filter);

  return (
    <div className="content-area">
      <div className="content-head">
        <div className="content-title-row">
          <h2 className="content-title">Containers</h2>
          <span className="content-count">{filtered.length} of {rows.length}</span>
        </div>
        <div className="content-actions">
          <Btn variant="ghost" icon="filter">Filter</Btn>
          <Btn variant="ghost" icon="arrow-up-down">Sort</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="download">Pull image</Btn>
          <Btn variant="primary" icon="plus">New container</Btn>
        </div>
      </div>

      <div className="content-toolbar">
        <div className="pills">
          {['all', 'running', 'stopped'].map(k => (
            <button key={k} className={`pill ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
              {k[0].toUpperCase() + k.slice(1)}
              <span className="pill-count">{k === 'all' ? rows.length : rows.filter(r => r.statusGroup === k).length}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-meta mono">auto-refresh · 5s</div>
      </div>

      <div className="ctable">
        <div className="ctable-head">
          <div className="col col-check"><input type="checkbox" /></div>
          <div className="col col-name">Name</div>
          <div className="col col-image">Image</div>
          <div className="col col-status">Status</div>
          <div className="col col-port">Ports</div>
          <div className="col col-cpu">CPU</div>
          <div className="col col-mem">Memory</div>
          <div className="col col-time">Started</div>
          <div className="col col-act"></div>
        </div>
        {filtered.map(row => (
          <div
            key={row.id}
            className={`ctable-row ${selectedId === row.id ? 'sel' : ''}`}
            onClick={() => setSelectedId(row.id)}
          >
            <div className="col col-check" onClick={e => e.stopPropagation()}><input type="checkbox" /></div>
            <div className="col col-name">
              <span className="row-name">{row.name}</span>
              <span className="row-id mono">{row.id}</span>
            </div>
            <div className="col col-image mono">{row.image}</div>
            <div className="col col-status"><Badge tone={row.tone}>{row.status}</Badge></div>
            <div className="col col-port mono">{row.ports || '—'}</div>
            <div className="col col-cpu mono">{row.cpu}</div>
            <div className="col col-mem mono">{row.mem}</div>
            <div className="col col-time mono">{row.started}</div>
            <div className="col col-act" onClick={e => e.stopPropagation()}>
              <button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { ContainerTable });

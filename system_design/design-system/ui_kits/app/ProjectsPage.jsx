/* global React, Icon, Btn, Badge, Dot, PROJECTS, ProjDot, ProjStatusBadge, ProjectLogsTab, ProjectFilesTab, ProjectSourceTab, UploadModal */
const { useState: useProjPgState } = React;

/* =========================================================================
   PROJECTS PAGE — left list + right detail
   ========================================================================= */
function ProjectsPage() {
  const [projects, setProjects] = useProjPgState(PROJECTS);
  const [selectedId, setSelectedId] = useProjPgState('jobs-api');
  const [tab, setTab] = useProjPgState('overview');
  const [query, setQuery] = useProjPgState('');
  const [uploadOpen, setUploadOpen] = useProjPgState(false);

  const selected = projects.find(p => p.id === selectedId);

  const setStatus = (id, patch) =>
    setProjects(ps => ps.map(p => p.id === id ? { ...p, ...patch } : p));

  // simulate a build → running cycle
  const build = (p) => {
    setStatus(p.id, { status: 'building', buildProgress: 8, buildStep: '1 of 6', lastDeploy: 'building…' });
    let prog = 8;
    const iv = setInterval(() => {
      prog += 18 + Math.random() * 12;
      if (prog >= 100) {
        clearInterval(iv);
        setStatus(p.id, { status: 'idle', built: true, buildProgress: 100, lastDeploy: 'just now', size: '218 MB' });
      } else {
        setStatus(p.id, { buildProgress: Math.round(prog), buildStep: `${Math.min(6, Math.ceil(prog / 17))} of 6` });
      }
    }, 700);
  };
  const run = (p) => setStatus(p.id, { status: 'running', lastDeploy: 'just now', cpu: '0.4%', mem: '92 MB' });
  const stop = (p) => setStatus(p.id, { status: 'idle', cpu: '—', mem: '—' });
  const retry = (p) => build(p);

  const list = projects.filter(p =>
    p.name.toLowerCase().includes(query.toLowerCase()) ||
    p.description.toLowerCase().includes(query.toLowerCase()));

  const running = projects.filter(p => p.status === 'running').length;

  const tabs = [
    { id: 'overview', label: 'Overview', icon: 'layout-panel-left' },
    { id: 'logs',     label: 'Logs',     icon: 'scroll-text' },
    { id: 'files',    label: 'Files',    icon: 'folder-tree' },
    { id: 'source',   label: 'Source',   icon: 'git-branch' },
  ];

  return (
    <div className="projects-layout">
      {/* ---------- LEFT: project list ---------- */}
      <aside className="proj-list">
        <div className="proj-list-head">
          <div className="proj-list-title">
            <span className="content-title" style={{ fontSize: 16 }}>Projects</span>
            <span className="content-count">{running} running · {projects.length} total</span>
          </div>
          <Btn variant="primary" size="sm" icon="upload" onClick={() => setUploadOpen(true)}>New</Btn>
        </div>
        <div className="proj-search">
          <Icon name="search" size={13} color="var(--fg-muted)" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search projects…" />
        </div>
        <div className="proj-items">
          {list.map(p => (
            <button
              key={p.id}
              className={`proj-item ${selectedId === p.id ? 'on' : ''}`}
              onClick={() => { setSelectedId(p.id); setTab('overview'); }}
            >
              <ProjDot status={p.status} size={9} />
              <div className="proj-item-main">
                <div className="proj-item-top">
                  <span className="proj-item-name">{p.name}</span>
                  <span className={`proj-type-tag ${p.type === 'Compose' ? 'compose' : ''}`}>
                    <Icon name={p.type === 'Compose' ? 'boxes' : 'file-code'} size={10} />
                    {p.type === 'Compose' ? 'Compose' : 'Dockerfile'}
                  </span>
                </div>
                <div className="proj-item-desc">{p.description}</div>
                <div className="proj-item-meta mono">
                  <span><Icon name="git-branch" size={10} /> {p.branch}</span>
                  <span>{p.lastDeploy}</span>
                </div>
              </div>
            </button>
          ))}
          {list.length === 0 && <div className="proj-empty">No projects match “{query}”.</div>}
        </div>
        <button className="proj-upload-cta" onClick={() => setUploadOpen(true)}>
          <Icon name="upload-cloud" size={16} />
          <span>Drop a folder or .zip to deploy</span>
        </button>
      </aside>

      {/* ---------- RIGHT: detail ---------- */}
      <section className="proj-detail">
        {selected && (
          <>
            <div className="proj-detail-head">
              <div className="proj-detail-titles">
                <div className="proj-detail-eyebrow eyebrow">
                  {selected.type} project · {selected.branch}
                </div>
                <div className="proj-detail-title">
                  <span>{selected.name}</span>
                  <ProjStatusBadge status={selected.status} />
                </div>
                <div className="proj-detail-desc">{selected.description}</div>
              </div>
              <ActionBar project={selected} build={build} run={run} stop={stop} retry={retry} />
            </div>

            {/* port conflict banner */}
            {selected.portConflict && selected.status === 'failed' && (
              <PortConflictBanner conflict={selected.portConflict} onResolve={() => setStatus(selected.id, { portConflict: null, status: 'idle' })} />
            )}

            <div className="proj-tabs">
              {tabs.map(t => (
                <button key={t.id} className={`proj-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
                  <Icon name={t.icon} size={14} /> {t.label}
                  {t.id === 'source' && (selected.git.staged.length + selected.git.unstaged.length > 0) &&
                    <span className="proj-tab-count">{selected.git.staged.length + selected.git.unstaged.length}</span>}
                </button>
              ))}
            </div>

            <div className="proj-tab-body">
              {tab === 'overview' && <ProjectOverviewTab project={selected} />}
              {tab === 'logs'     && <ProjectLogsTab project={selected} setStatus={setStatus} />}
              {tab === 'files'    && <ProjectFilesTab project={selected} />}
              {tab === 'source'   && <ProjectSourceTab project={selected} />}
            </div>
          </>
        )}
      </section>

      {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}
    </div>
  );
}

/* =========================================================================
   ADAPTIVE ACTION BAR
   ========================================================================= */
function ActionBar({ project, build, run, stop, retry }) {
  const s = project.status;
  if (s === 'building') {
    return (
      <div className="action-bar">
        <div className="build-inline">
          <span className="build-inline-track"><span className="build-inline-fill" style={{ width: `${project.buildProgress || 0}%` }} /></span>
          <span className="mono build-inline-pct">{project.buildProgress || 0}% · step {project.buildStep}</span>
        </div>
        <Btn variant="secondary" icon="x">Cancel</Btn>
      </div>
    );
  }
  if (s === 'running') {
    return (
      <div className="action-bar">
        <Btn variant="ghost" icon="rotate-ccw" onClick={() => { stop(project); setTimeout(() => run(project), 400); }}>Restart</Btn>
        <Btn variant="secondary" icon="square" onClick={() => stop(project)}>Stop</Btn>
        <Btn variant="primary" icon="external-link">Open :{project.ports[0]?.host || '—'}</Btn>
      </div>
    );
  }
  if (s === 'failed') {
    return (
      <div className="action-bar">
        <Btn variant="ghost" icon="scroll-text">View logs</Btn>
        <Btn variant="primary" icon="rotate-ccw" onClick={() => retry(project)}>Retry build</Btn>
      </div>
    );
  }
  // idle / stopped
  return (
    <div className="action-bar">
      <Btn variant={project.built ? 'secondary' : 'primary'} icon="hammer" onClick={() => build(project)}>
        {project.built ? 'Rebuild' : 'Build'}
      </Btn>
      {project.built && <Btn variant="primary" icon="play" onClick={() => run(project)}>Run</Btn>}
    </div>
  );
}

/* =========================================================================
   PORT CONFLICT BANNER
   ========================================================================= */
function PortConflictBanner({ conflict, onResolve }) {
  const [port, setPort] = useProjPgState(conflict.host + 1);
  return (
    <div className="port-conflict">
      <Icon name="triangle-alert" size={16} color="var(--danger-400)" />
      <div className="port-conflict-text">
        <div className="port-conflict-title">Port {conflict.host} is already in use by <span className="mono">{conflict.by}</span></div>
        <div className="port-conflict-sub">Remap the host port to continue, or stop the conflicting container.</div>
      </div>
      <div className="port-conflict-form">
        <span className="mono port-arrow">host</span>
        <input className="port-input mono" type="number" value={port} onChange={e => setPort(e.target.value)} />
        <span className="mono port-arrow">→ {conflict.host}</span>
        <Btn variant="primary" size="sm" icon="check" onClick={onResolve}>Remap & build</Btn>
      </div>
    </div>
  );
}

/* =========================================================================
   OVERVIEW TAB
   ========================================================================= */
function ProjectOverviewTab({ project }) {
  return (
    <div className="proj-overview">
      <div className="proj-ov-grid">
        <OvStat label="Status" >
          <span className="ov-status"><ProjDot status={project.status} size={8} /> {(window.PROJ_STATUS[project.status] || {}).label}</span>
        </OvStat>
        <OvStat label="Image" mono>{project.image}</OvStat>
        <OvStat label="Size" mono>{project.size}</OvStat>
        <OvStat label="CPU" mono>{project.cpu}</OvStat>
        <OvStat label="Memory" mono>{project.mem}</OvStat>
        <OvStat label="Last deploy" mono>{project.lastDeploy}</OvStat>
      </div>

      <section className="dsection">
        <div className="dsection-head"><span className="eyebrow">Port mappings</span></div>
        {project.ports.length > 0 ? (
          <div className="port-list">
            {project.ports.map(p => (
              <div className="port-row" key={p.host}>
                <span className="mono port-host">0.0.0.0:{p.host}</span>
                <Icon name="arrow-right" size={13} color="var(--fg-subtle)" />
                <span className="mono port-target">{p.container}/tcp</span>
                {project.status === 'running' && <a href="#" className="port-open">Open ↗</a>}
              </div>
            ))}
          </div>
        ) : <div className="proj-none mono">No published ports</div>}
      </section>

      <section className="dsection">
        <div className="dsection-head"><span className="eyebrow">Detected configuration</span></div>
        <div className="detect-grid">
          <div className="detect-item">
            <Icon name={project.type === 'Compose' ? 'boxes' : 'file-code'} size={16} color="var(--accent)" />
            <div>
              <div className="detect-k">Build source</div>
              <div className="detect-v mono">{project.type === 'Compose' ? 'compose.yml' : 'Dockerfile'}</div>
            </div>
          </div>
          <div className="detect-item">
            <Icon name="git-branch" size={16} color="var(--accent)" />
            <div>
              <div className="detect-k">Tracking branch</div>
              <div className="detect-v mono">{project.branch}</div>
            </div>
          </div>
          <div className="detect-item">
            <Icon name="layers" size={16} color="var(--accent)" />
            <div>
              <div className="detect-k">Image tag</div>
              <div className="detect-v mono">{project.image}</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function OvStat({ label, children, mono }) {
  return (
    <div className="ov-stat">
      <div className="ov-stat-label">{label}</div>
      <div className={`ov-stat-value ${mono ? 'mono' : ''}`}>{children}</div>
    </div>
  );
}

Object.assign(window, { ProjectsPage });

/* global React, Icon, Btn, Badge, Dot, PageHead, PageToolbar */
const { useState: useObsState } = React;

/* =========================================================================
   LOGS — cross-container live stream
   ========================================================================= */
const LOG_SOURCES = [
  { name: 'nginx-prod',    color: '#22D3EE', count: 124, on: true },
  { name: 'api-prod',      color: '#34D399', count: 318, on: true },
  { name: 'postgres-main', color: '#60A5FA', count:  42, on: true },
  { name: 'worker-jobs',   color: '#FBBF24', count:  28, on: true },
  { name: 'cache',         color: '#94A3B8', count:   0, on: false },
];

const LOG_LINES = [
  ['14:32:08.142', 'INFO', 'api-prod',      '#34D399', 'listening on :3000'],
  ['14:32:08.319', 'INFO', 'api-prod',      '#34D399', 'connected to postgres-main'],
  ['14:32:11.402', 'INFO', 'nginx-prod',    '#22D3EE', 'GET /healthz 200 4ms'],
  ['14:32:11.998', 'INFO', 'postgres-main', '#60A5FA', 'autovacuum: ANALYZE public.jobs'],
  ['14:32:14.811', 'WARN', 'api-prod',      '#34D399', 'slow query: SELECT * FROM jobs (412ms)'],
  ['14:32:15.012', 'INFO', 'worker-jobs',   '#FBBF24', 'picked up job 87a2'],
  ['14:32:17.220', 'INFO', 'worker-jobs',   '#FBBF24', 'job 87a2 completed in 2.2s'],
  ['14:32:18.221', 'ERR',  'api-prod',      '#34D399', 'upstream 502 — worker-jobs unreachable'],
  ['14:32:18.412', 'INFO', 'api-prod',      '#34D399', 'retry 1/3 in 200ms…'],
  ['14:32:18.612', 'INFO', 'api-prod',      '#34D399', 'retry 2/3 succeeded'],
  ['14:32:21.004', 'INFO', 'nginx-prod',    '#22D3EE', 'GET /api/jobs?limit=50 200 124ms'],
  ['14:32:21.508', 'INFO', 'postgres-main', '#60A5FA', 'checkpoint complete: wrote 218 buffers (1.4%)'],
  ['14:32:22.119', 'INFO', 'nginx-prod',    '#22D3EE', 'GET /api/jobs/87a2 200 18ms'],
  ['14:32:24.508', 'INFO', 'nginx-prod',    '#22D3EE', 'GET /healthz 200 3ms'],
  ['14:32:25.221', 'INFO', 'worker-jobs',   '#FBBF24', 'picked up job 87a3'],
];

function LogsPage() {
  const [level, setLevel] = useObsState('all');
  return (
    <div className="content-area">
      <PageHead
        title="Logs"
        eyebrow="cross-container · live"
        actions={<>
          <Btn variant="ghost" icon="bookmark">Pin view</Btn>
          <Btn variant="ghost" icon="download">Export</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="pause">Pause</Btn>
          <Btn variant="primary" icon="terminal">Open shell</Btn>
        </>}
      />
      <div className="logs-layout">
        <aside className="logs-side">
          <div className="logs-side-head">
            <span className="eyebrow">Sources</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>5 of 12</span>
          </div>
          {LOG_SOURCES.map(s => (
            <label key={s.name} className={`src-row ${!s.on ? 'is-off' : ''}`}>
              <input type="checkbox" defaultChecked={s.on} />
              <span className="src-dot" style={{ background: s.color }} />
              <span className="src-name">{s.name}</span>
              <span className="src-count mono">{s.count}</span>
            </label>
          ))}
          <button className="src-add"><Icon name="plus" size={12} /> Add source</button>
        </aside>
        <section className="logs-main">
          <div className="logs-toolbar">
            <div className="logs-search-wrap">
              <Icon name="search" size={13} color="var(--fg-muted)" />
              <input className="logs-search" placeholder="Filter regex or JSON path…" />
            </div>
            <div className="pills sm">
              {['all', 'info', 'warn', 'error'].map(l => (
                <button key={l} className={`pill ${level === l ? 'on' : ''}`} onClick={() => setLevel(l)}>
                  {l[0].toUpperCase() + l.slice(1)}
                </button>
              ))}
            </div>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--running-400)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Dot tone="running" /> live · 12 lines/s
            </span>
          </div>
          <div className="logs-stream">
            {LOG_LINES.map(([ts, lvl, src, color, msg], i) => (
              <div className="lline" key={i}>
                <span className="lts">{ts}</span>
                <span className={`llvl lvl-${lvl.trim().toLowerCase()}`}>{lvl.padEnd(4)}</span>
                <span className="lsrc" style={{ color }}>{src}</span>
                <span className="lmsg">{msg}</span>
              </div>
            ))}
            <div className="lline live-cursor">
              <span className="cursor" style={{ width: 5, height: 11 }} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* =========================================================================
   METRICS — chart grid
   ========================================================================= */
const HOST_METRICS = {
  cpu:    { value: '12%',    series: [5,7,6,9,8,11,9,12,10,12,11,12] },
  mem:    { value: '8.4 GB', series: [6,6,7,7,8,8,8,7,8,9,8,8] },
  netIn:  { value: '4.2 MB/s', series: [2,3,4,3,5,4,6,5,4,5,4,4] },
  netOut: { value: '1.8 MB/s', series: [1,1,2,1,2,2,3,2,2,2,2,2] },
};
const TOP_CONTAINERS = [
  { name: 'api-prod',      cpu: 4.7, mem: 186, color: '#34D399' },
  { name: 'postgres-main', cpu: 2.1, mem: 412, color: '#60A5FA' },
  { name: 'queue-broker',  cpu: 0.8, mem: 128, color: '#22D3EE' },
  { name: 'web-prod',      cpu: 0.8, mem:  92, color: '#FBBF24' },
  { name: 'metrics-otel',  cpu: 0.6, mem:  54, color: '#A78BFA' },
];

function Sparkline({ series, color = 'var(--accent)', fill = true }) {
  const max = Math.max(...series);
  const w = 200, h = 60;
  const pts = series.map((v, i) => `${(i * w) / (series.length - 1)},${h - (v / max) * (h - 6) - 2}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h }}>
      {fill && <polygon points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity="0.12" />}
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function MetricsPage() {
  return (
    <div className="content-area">
      <PageHead
        title="Metrics"
        eyebrow="host · production · us-east-1"
        actions={<>
          <Btn variant="ghost" icon="clock">Last 15m</Btn>
          <Btn variant="ghost" icon="refresh-ccw">Auto · 5s</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="bookmark">Pin dashboard</Btn>
          <Btn variant="primary" icon="bell">New alert</Btn>
        </>}
      />
      <div style={{ padding: '0 20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="metrics-grid">
          <div className="m-card">
            <div className="m-top"><span className="eyebrow">CPU usage</span><span className="m-val mono">{HOST_METRICS.cpu.value}</span></div>
            <Sparkline series={HOST_METRICS.cpu.series} color="#22D3EE" />
            <div className="m-foot mono">avg 9.4% · peak 12%</div>
          </div>
          <div className="m-card">
            <div className="m-top"><span className="eyebrow">Memory</span><span className="m-val mono">{HOST_METRICS.mem.value}</span></div>
            <Sparkline series={HOST_METRICS.mem.series} color="#34D399" />
            <div className="m-foot mono">52% of 16 GB</div>
          </div>
          <div className="m-card">
            <div className="m-top"><span className="eyebrow">Network in</span><span className="m-val mono">{HOST_METRICS.netIn.value}</span></div>
            <Sparkline series={HOST_METRICS.netIn.series} color="#60A5FA" />
            <div className="m-foot mono">peak 6.1 MB/s</div>
          </div>
          <div className="m-card">
            <div className="m-top"><span className="eyebrow">Network out</span><span className="m-val mono">{HOST_METRICS.netOut.value}</span></div>
            <Sparkline series={HOST_METRICS.netOut.series} color="#FBBF24" />
            <div className="m-foot mono">peak 2.8 MB/s</div>
          </div>
        </div>

        <div className="metrics-wide">
          <div className="m-card">
            <div className="m-top">
              <span className="eyebrow">CPU by container · last 15m</span>
              <div className="legend">
                {TOP_CONTAINERS.slice(0, 4).map(c => (
                  <span key={c.name} className="leg-it"><span className="leg-dot" style={{ background: c.color }} /> {c.name}</span>
                ))}
              </div>
            </div>
            <svg viewBox="0 0 600 140" preserveAspectRatio="none" style={{ width: '100%', height: 140 }}>
              {TOP_CONTAINERS.slice(0, 4).map((c, i) => {
                const base = 5 - i; // synthetic stacking pattern
                const pts = Array.from({ length: 24 }, (_, x) => {
                  const v = Math.max(0, c.cpu + Math.sin(x * 0.5 + i) * (c.cpu * 0.4) + (i === 0 ? Math.sin(x * 0.3) * 0.8 : 0));
                  return `${(x * 600) / 23},${130 - v * 18}`;
                }).join(' ');
                return <polyline key={c.name} points={pts} fill="none" stroke={c.color} strokeWidth="1.5" />;
              })}
              <line x1="0" y1="130" x2="600" y2="130" stroke="var(--border-subtle)" />
            </svg>
            <div className="m-foot mono" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>14:17:00</span><span>14:22:00</span><span>14:27:00</span><span>14:32:00</span>
            </div>
          </div>
        </div>

        <div className="metrics-wide">
          <div className="m-card">
            <div className="m-top">
              <span className="eyebrow">Top containers · memory</span>
            </div>
            <div className="bars">
              {TOP_CONTAINERS.map(c => {
                const max = Math.max(...TOP_CONTAINERS.map(x => x.mem));
                return (
                  <div className="bar-row" key={c.name}>
                    <span className="bar-name">{c.name}</span>
                    <span className="bar-track"><span className="bar-fill" style={{ width: `${(c.mem / max) * 100}%`, background: c.color }} /></span>
                    <span className="bar-val mono">{c.mem} MB</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   EVENTS
   ========================================================================= */
const EVENTS = [
  { at: '14:32:24', type: 'start',    object: 'container nginx-prod',     by: 'mara@dockyard', tone: 'running', icon: 'play' },
  { at: '14:32:18', type: 'error',    object: 'container worker-jobs',    by: 'engine',        tone: 'danger',  icon: 'circle-x',    note: 'exit code 137 (OOM)' },
  { at: '14:31:55', type: 'pull',     object: 'image internal/api:2026.05', by: 'ci/main',     tone: 'info',    icon: 'download' },
  { at: '14:31:42', type: 'create',   object: 'container ingest-staging', by: 'kai@dockyard',  tone: 'info',    icon: 'plus' },
  { at: '14:30:21', type: 'restart',  object: 'container postgres-main',  by: 'mara@dockyard', tone: 'warn',    icon: 'rotate-ccw' },
  { at: '14:28:08', type: 'build',    object: 'image internal/web:2026.05', by: 'mara@dockyard', tone: 'running', icon: 'hammer', note: 'succeeded in 42s' },
  { at: '14:24:14', type: 'attach',   object: 'volume pgdata',            by: 'engine',        tone: 'info',    icon: 'database' },
  { at: '14:20:01', type: 'destroy',  object: 'container old-ingest',     by: 'mara@dockyard', tone: 'danger',  icon: 'trash-2' },
  { at: '14:18:36', type: 'connect',  object: 'network app-net',          by: 'engine',        tone: 'info',    icon: 'network' },
  { at: '14:15:02', type: 'login',    object: 'registry ghcr.io',         by: 'ci/main',       tone: 'info',    icon: 'cloud' },
  { at: '14:12:44', type: 'update',   object: 'engine 26.1.4 → 26.2.0',   by: 'system',        tone: 'info',    icon: 'arrow-up-circle' },
];

function EventsPage() {
  return (
    <div className="content-area">
      <PageHead
        title="Events"
        eyebrow="real-time · all sources"
        actions={<>
          <Btn variant="ghost" icon="filter">Filter</Btn>
          <Btn variant="ghost" icon="bookmark">Pin filter</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="download">Export JSONL</Btn>
          <Btn variant="primary" icon="bell">Alert from filter</Btn>
        </>}
      />
      <PageToolbar
        filters={[
          { id: 'all',    label: 'All',       count: EVENTS.length },
          { id: 'error',  label: 'Errors',    count: 2 },
          { id: 'system', label: 'System',    count: 2 },
        ]}
        filter="all" setFilter={() => {}}
        right={<span><Dot tone="running" />&nbsp;live · 248 events / 5m</span>}
      />
      <div className="events-list">
        {EVENTS.map((e, i) => (
          <div key={i} className="event-row">
            <span className="event-ts mono">{e.at}</span>
            <span className={`event-rail event-rail-${e.tone}`}><Icon name={e.icon} size={12} /></span>
            <span className="event-type">{e.type}</span>
            <span className="event-obj mono">{e.object}</span>
            {e.note && <span className="event-note">{e.note}</span>}
            <span className="event-by mono">{e.by}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { LogsPage, MetricsPage, EventsPage });

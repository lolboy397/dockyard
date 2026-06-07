/* global React, Icon, Dot, Badge, ProjDot, PROJECTS */
const { useState: useDashState, useEffect: useDashEffect } = React;

/* ---- mini chart helpers ---- */
function DashSpark({ series, color, h = 48, fill = true }) {
  const max = Math.max(...series), min = Math.min(...series);
  const w = 240;
  const pts = series.map((v, i) => `${(i * w) / (series.length - 1)},${h - ((v - min) / (max - min || 1)) * (h - 6) - 3}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, display: 'block' }}>
      {fill && <polygon points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity="0.10" />}
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Ring({ pct, color, size = 88, label, value }) {
  const r = size / 2 - 7, c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--bg-inset)" strokeWidth="6" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
          transform={`rotate(-90 ${size/2} ${size/2})`} style={{ transition: 'stroke-dashoffset 600ms var(--ease-out)' }} />
      </svg>
      <div className="ring-center">
        <div className="ring-value mono">{value}</div>
        <div className="ring-label">{label}</div>
      </div>
    </div>
  );
}

const ACTIVITY = [
  { t: '14:32:24', icon: 'play',       tone: 'running', text: 'nginx-prod started',                who: 'mara' },
  { t: '14:32:18', icon: 'circle-x',   tone: 'danger',  text: 'worker-jobs exited (137 OOM)',       who: 'engine' },
  { t: '14:31:55', icon: 'download',   tone: 'info',    text: 'pulled internal/api:2026.05',        who: 'ci' },
  { t: '14:28:08', icon: 'hammer',     tone: 'running', text: 'built web-storefront in 42s',         who: 'mara' },
  { t: '14:24:14', icon: 'git-commit-horizontal', tone: 'info', text: 'pushed 2 commits to jobs-api', who: 'mara' },
  { t: '14:20:01', icon: 'rocket',     tone: 'running', text: 'deployed analytics-worker',           who: 'kai' },
];

function Dashboard() {
  const [now, setNow] = useDashState(new Date());
  useDashEffect(() => { const iv = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(iv); }, []);
  const time = now.toLocaleTimeString('en-US', { hour12: false });
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  const running = PROJECTS.filter(p => p.status === 'running').length;
  const building = PROJECTS.filter(p => p.status === 'building').length;
  const failed = PROJECTS.filter(p => p.status === 'failed').length;

  return (
    <div className="dash">
      {/* header band */}
      <div className="dash-header">
        <div className="dash-header-left">
          <div className="dash-env">
            <Dot tone="running" size={9} />
            <span className="dash-env-name">production</span>
            <span className="dash-env-region mono">us-east-1 · 14 nodes</span>
          </div>
          <h1 className="dash-h1">All systems operational</h1>
        </div>
        <div className="dash-clock">
          <div className="dash-time mono">{time}</div>
          <div className="dash-date">{date}</div>
        </div>
      </div>

      {/* hero KPI row */}
      <div className="dash-kpis">
        <KpiCard icon="box" label="Containers" value="12" sub="of 14 running" tone="running" series={[8,9,9,10,11,10,12,11,12,12]} />
        <KpiCard icon="rocket" label="Projects" value={String(running)} sub={`${building} building · ${failed} failed`} tone="info" series={[3,3,4,4,5,5,5,6,6,6]} />
        <KpiCard icon="layers" label="Images" value="38" sub="1.6 GB · 198 MB reclaimable" tone="info" series={[30,31,33,34,35,36,37,37,38,38]} />
        <KpiCard icon="git-commit-horizontal" label="Deploys today" value="24" sub="avg 47s · 96% success" tone="running" series={[2,5,8,11,14,17,19,21,23,24]} />
      </div>

      <div className="dash-grid">
        {/* resource gauges */}
        <div className="dash-card span-4">
          <div className="dash-card-head"><span className="eyebrow">Host resources</span><span className="mono dim">live · 5s</span></div>
          <div className="rings">
            <Ring pct={12} color="#22D3EE" value="12%" label="CPU" />
            <Ring pct={52} color="#34D399" value="8.4G" label="Memory" />
            <Ring pct={89} color="#FBBF24" value="89%" label="Disk" />
          </div>
          <div className="res-foot mono">
            <span>16 cores</span><span>16 GB RAM</span><span>244 GB SSD</span>
          </div>
        </div>

        {/* throughput chart */}
        <div className="dash-card span-8">
          <div className="dash-card-head">
            <span className="eyebrow">Cluster throughput · last 60m</span>
            <div className="legend">
              <span className="leg-it"><span className="leg-dot" style={{ background: '#22D3EE' }} /> requests/s</span>
              <span className="leg-it"><span className="leg-dot" style={{ background: '#34D399' }} /> network in</span>
            </div>
          </div>
          <div className="dual-chart">
            <DashSpark series={[42,48,45,60,72,68,90,84,76,98,92,110,104,96,120,112,124]} color="#22D3EE" h={120} />
          </div>
          <div className="chart-axis mono"><span>13:32</span><span>13:47</span><span>14:02</span><span>14:17</span><span>14:32</span></div>
        </div>

        {/* projects status */}
        <div className="dash-card span-7">
          <div className="dash-card-head"><span className="eyebrow">Projects</span><span className="mono dim">{running} running · {PROJECTS.length} total</span></div>
          <div className="dash-proj-grid">
            {PROJECTS.map(p => (
              <div key={p.id} className={`dash-proj dash-proj-${p.status}`}>
                <div className="dash-proj-top">
                  <ProjDot status={p.status} size={9} />
                  <span className="dash-proj-name">{p.name}</span>
                  <Icon name={p.type === 'Compose' ? 'boxes' : 'file-code'} size={12} color="var(--fg-subtle)" />
                </div>
                <div className="dash-proj-meta mono">
                  {p.status === 'running' ? <span>{p.cpu} · {p.mem}</span>
                    : p.status === 'building' ? <span className="amber">building {p.buildProgress}%</span>
                    : p.status === 'failed' ? <span className="red">build failed</span>
                    : <span>{p.lastDeploy}</span>}
                  {p.ports[0] && <span className="dash-proj-port mono">:{p.ports[0].host}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* activity feed */}
        <div className="dash-card span-5">
          <div className="dash-card-head"><span className="eyebrow">Live activity</span><span className="mono live-pulse"><Dot tone="running" size={6} /> live</span></div>
          <div className="dash-activity">
            {ACTIVITY.map((a, i) => (
              <div className="dash-act-row" key={i}>
                <span className="dash-act-time mono">{a.t}</span>
                <span className={`dash-act-ic dash-act-${a.tone}`}><Icon name={a.icon} size={11} /></span>
                <span className="dash-act-text">{a.text}</span>
                <span className="dash-act-who mono">{a.who}</span>
              </div>
            ))}
          </div>
        </div>

        {/* node strip */}
        <div className="dash-card span-12">
          <div className="dash-card-head"><span className="eyebrow">Nodes · us-east-1</span><span className="mono dim">14 healthy · 0 draining</span></div>
          <div className="node-strip">
            {Array.from({ length: 14 }).map((_, i) => {
              const load = [12,34,8,56,22,44,18,72,30,15,48,26,9,38][i];
              const tone = load > 70 ? 'warn' : 'running';
              return (
                <div className="node-cell" key={i} title={`node-${i+1} · ${load}%`}>
                  <div className="node-bar"><div className={`node-fill node-${tone}`} style={{ height: `${load}%` }} /></div>
                  <span className="node-id mono">{String(i+1).padStart(2,'0')}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, sub, tone, series }) {
  const color = { running: '#34D399', info: '#22D3EE', warn: '#FBBF24', danger: '#F87171' }[tone] || '#22D3EE';
  return (
    <div className="kpi-card">
      <div className="kpi-top">
        <span className="kpi-ic" style={{ color }}><Icon name={icon} size={16} /></span>
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value mono">{value}</div>
      <div className="kpi-sub">{sub}</div>
      <div className="kpi-spark"><DashSpark series={series} color={color} h={36} /></div>
    </div>
  );
}

Object.assign(window, { Dashboard });

/* global React, Icon, Btn, Badge, Dot */
const { useState: useDState } = React;

function DetailPanel({ container, onClose }) {
  const [tab, setTab] = useDState('overview');
  if (!container) return null;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'logs',     label: 'Logs' },
    { id: 'shell',    label: 'Shell' },
    { id: 'ports',    label: 'Ports' },
    { id: 'env',      label: 'Env' },
    { id: 'mounts',   label: 'Mounts' },
  ];

  return (
    <aside className="detail">
      <div className="detail-head">
        <div className="detail-titles">
          <div className="detail-eyebrow eyebrow">container · {container.id}</div>
          <div className="detail-title">
            <span>{container.name}</span>
            <Badge tone={container.tone}>{container.status}</Badge>
          </div>
        </div>
        <div className="detail-head-actions">
          <Btn variant="secondary" size="sm" icon="rotate-ccw">Restart</Btn>
          <Btn variant="secondary" size="sm" icon="square">Stop</Btn>
          <button className="icon-btn ghost" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
      </div>

      <div className="detail-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`dtab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {tab === 'overview' && <DetailOverview c={container} />}
        {tab === 'logs'     && <DetailLogs c={container} />}
        {tab === 'shell'    && <DetailShell c={container} />}
        {tab === 'ports'    && <DetailPorts c={container} />}
        {tab === 'env'      && <DetailEnv c={container} />}
        {tab === 'mounts'   && <DetailMounts c={container} />}
      </div>
    </aside>
  );
}

function MetaGrid({ rows }) {
  return (
    <div className="meta-grid">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <div className="meta-k">{k}</div>
          <div className="meta-v mono">{v}</div>
        </React.Fragment>
      ))}
    </div>
  );
}

function DetailOverview({ c }) {
  return (
    <div className="dbody">
      <section className="dsection">
        <div className="dsection-head"><span className="eyebrow">Resource use</span></div>
        <div className="metrics">
          <Metric label="CPU"    value={c.cpu}     spark={[2,4,3,5,4,6,5,4]} />
          <Metric label="Memory" value={c.mem}     spark={[3,3,4,5,5,6,6,7]} />
          <Metric label="Network in" value="1.2 MB/s" spark={[1,2,3,2,4,3,5,4]} />
          <Metric label="Network out" value="0.4 MB/s" spark={[1,1,2,1,2,2,3,2]} />
        </div>
      </section>

      <section className="dsection">
        <div className="dsection-head"><span className="eyebrow">Details</span></div>
        <MetaGrid rows={[
          ['Image', c.image],
          ['ID', c.fullId || (c.id + 'b9e22ff4c031')],
          ['Created', '2026‑05‑24 12:14:08 UTC'],
          ['Command', '/docker-entrypoint.sh nginx -g "daemon off;"'],
          ['Network', 'bridge · 172.17.0.4'],
          ['Restart policy', 'unless-stopped'],
        ]}/>
      </section>

      <section className="dsection">
        <div className="dsection-head"><span className="eyebrow">Labels</span></div>
        <div className="chips">
          <span className="chip">app=web</span>
          <span className="chip">env=production</span>
          <span className="chip">team=platform</span>
          <span className="chip">version=1.27.0</span>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, spark }) {
  const max = Math.max(...spark);
  const points = spark.map((v, i) => `${(i * 70) / (spark.length - 1)},${28 - (v / max) * 24}`).join(' ');
  return (
    <div className="metric">
      <div className="metric-top">
        <span className="metric-label">{label}</span>
        <svg className="metric-spark" viewBox="0 0 70 28" fill="none">
          <polyline points={points} stroke="#22D3EE" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="metric-value mono">{value}</div>
    </div>
  );
}

function DetailLogs({ c }) {
  const lines = [
    ['14:32:08.142', 'INFO', `${c.name} listening on :8080`],
    ['14:32:08.319', 'INFO', 'connected to postgres-main'],
    ['14:32:11.402', 'INFO', 'GET /healthz 200 4ms'],
    ['14:32:14.811', 'WARN', 'slow query: SELECT * FROM jobs (412ms)'],
    ['14:32:18.221', 'ERR',  'upstream 502 — worker-jobs unreachable'],
    ['14:32:18.412', 'INFO', 'retry 1/3 in 200ms…'],
    ['14:32:18.612', 'INFO', 'retry 2/3 succeeded'],
    ['14:32:21.004', 'INFO', 'GET /api/jobs?limit=50 200 124ms'],
    ['14:32:22.119', 'INFO', 'GET /api/jobs/87a2 200 18ms'],
    ['14:32:24.508', 'INFO', 'GET /healthz 200 3ms'],
  ];
  return (
    <div className="dbody dlogs">
      <div className="logs-toolbar">
        <input className="logs-search" placeholder="Filter logs…" />
        <div className="pills sm">
          <button className="pill on">All</button>
          <button className="pill">Info</button>
          <button className="pill">Warn</button>
          <button className="pill">Error</button>
        </div>
        <span className="logs-live"><Dot tone="running" /> live</span>
      </div>
      <div className="logs">
        {lines.map(([ts, lvl, msg], i) => (
          <div className="lline" key={i}>
            <span className="lts">{ts}</span>
            <span className={`llvl lvl-${lvl.trim().toLowerCase()}`}>{lvl.padEnd(4)}</span>
            <span className="lmsg">{msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailShell({ c }) {
  return (
    <div className="dbody dshell">
      <div className="shell-head"><span className="mono small">root@{c.name}:/#</span></div>
      <div className="shell-body">
        <div><span className="prompt">root@{c.name}:/#</span> ls /etc/nginx</div>
        <div>conf.d  fastcgi.conf  mime.types  nginx.conf  scgi_params  uwsgi_params</div>
        <div><span className="prompt">root@{c.name}:/#</span> nginx -t</div>
        <div>nginx: configuration file /etc/nginx/nginx.conf test is successful</div>
        <div><span className="prompt">root@{c.name}:/#</span> <span className="cursor" /></div>
      </div>
    </div>
  );
}

function DetailPorts({ c }) {
  const ports = [
    { host: '0.0.0.0:8080', target: '80/tcp', protocol: 'HTTP' },
    { host: '0.0.0.0:8443', target: '443/tcp', protocol: 'HTTPS' },
  ];
  return (
    <div className="dbody">
      <section className="dsection">
        <div className="dsection-head">
          <span className="eyebrow">Published ports</span>
          <Btn variant="ghost" size="sm" icon="plus">Add</Btn>
        </div>
        <table className="kv-table">
          <thead><tr><th>Host</th><th>Container</th><th>Protocol</th><th></th></tr></thead>
          <tbody>
            {ports.map(p => (
              <tr key={p.host}>
                <td className="mono">{p.host}</td>
                <td className="mono">→ {p.target}</td>
                <td>{p.protocol}</td>
                <td><a href="#" className="open-link">Open ↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function DetailEnv({ c }) {
  const env = [
    ['NGINX_VERSION', '1.27.0'],
    ['NGINX_PORT', '80'],
    ['DATABASE_URL', 'postgres://app:****@postgres-main:5432/app'],
    ['LOG_LEVEL', 'info'],
    ['NODE_ENV', 'production'],
  ];
  return (
    <div className="dbody">
      <section className="dsection">
        <div className="dsection-head">
          <span className="eyebrow">Environment variables</span>
          <Btn variant="ghost" size="sm" icon="copy">Copy as .env</Btn>
        </div>
        <div className="env-list">
          {env.map(([k, v]) => (
            <div className="env-row" key={k}>
              <span className="mono env-k">{k}</span>
              <span className="mono env-v">{v}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function DetailMounts({ c }) {
  return (
    <div className="dbody">
      <section className="dsection">
        <div className="dsection-head"><span className="eyebrow">Volume mounts</span></div>
        <div className="env-list">
          <div className="env-row"><span className="mono env-k">/etc/nginx/conf.d</span><span className="mono env-v">← nginx-config (rw)</span></div>
          <div className="env-row"><span className="mono env-k">/var/log/nginx</span><span className="mono env-v">← nginx-logs (rw)</span></div>
        </div>
      </section>
    </div>
  );
}

Object.assign(window, { DetailPanel });

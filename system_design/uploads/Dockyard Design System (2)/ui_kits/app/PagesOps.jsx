/* global React, Icon, Btn, Badge, Dot, PageHead, PageToolbar */
const { useState: useOState } = React;

/* =========================================================================
   COMPOSE — stacks
   ========================================================================= */
const STACKS = [
  {
    name: 'production', file: 'compose.prod.yml', updated: '4h ago', branch: 'main',
    services: [
      { name: 'web',       image: 'internal/web:2026.05',    status: 'Running',    tone: 'running', replicas: '2/2' },
      { name: 'api',       image: 'internal/api:2026.05',    status: 'Running',    tone: 'running', replicas: '3/3' },
      { name: 'worker',    image: 'internal/worker:42',      status: 'Restarting', tone: 'warn',    replicas: '1/2' },
      { name: 'postgres',  image: 'postgres:16.2',           status: 'Running',    tone: 'running', replicas: '1/1' },
      { name: 'redis',     image: 'redis:7.2-alpine',        status: 'Exited',     tone: 'idle',    replicas: '0/1' },
    ],
  },
  {
    name: 'staging', file: 'compose.staging.yml', updated: '8m ago', branch: 'main',
    services: [
      { name: 'web',     image: 'internal/web:nightly',  status: 'Running', tone: 'running', replicas: '1/1' },
      { name: 'api',     image: 'internal/api:nightly',  status: 'Running', tone: 'running', replicas: '1/1' },
      { name: 'ingest',  image: 'internal/ingest:nightly', status: 'Crashed', tone: 'danger', replicas: '0/1' },
    ],
  },
  {
    name: 'observability', file: 'compose.obs.yml', updated: '6h ago', branch: 'platform',
    services: [
      { name: 'otel-collector', image: 'otel/collector:0.103', status: 'Running', tone: 'running', replicas: '1/1' },
      { name: 'prometheus',     image: 'prom/prometheus:2.55', status: 'Running', tone: 'running', replicas: '1/1' },
      { name: 'grafana',        image: 'grafana/grafana:10.4', status: 'Running', tone: 'running', replicas: '1/1' },
    ],
  },
];

function ComposePage() {
  const [open, setOpen] = useOState({ production: true, staging: true, observability: false });
  const toggle = (k) => setOpen(o => ({ ...o, [k]: !o[k] }));

  return (
    <div className="content-area">
      <PageHead
        title="Compose"
        count={STACKS.length}
        actions={<>
          <Btn variant="ghost" icon="git-pull-request">Plan changes</Btn>
          <Btn variant="ghost" icon="git-compare">Diff</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="play">Up all</Btn>
          <Btn variant="primary" icon="plus">New stack</Btn>
        </>}
      />
      <PageToolbar
        filters={[
          { id: 'all',     label: 'All',      count: STACKS.length },
          { id: 'healthy', label: 'Healthy',  count: 1 },
          { id: 'issues',  label: 'Issues',   count: 2 },
        ]}
        filter="all" setFilter={() => {}}
        right={<>11 services · 7 healthy · 2 issues</>}
      />
      <div className="stacks">
        {STACKS.map(s => {
          const running = s.services.filter(x => x.tone === 'running').length;
          const total = s.services.length;
          const tone = s.services.some(x => x.tone === 'danger') ? 'danger'
                     : s.services.some(x => x.tone === 'warn') ? 'warn'
                     : running === total ? 'running' : 'warn';
          return (
            <div className="stack" key={s.name}>
              <div className="stack-head" onClick={() => toggle(s.name)}>
                <span className={`stack-chev ${open[s.name] ? 'on' : ''}`}><Icon name="chevron-right" size={14} /></span>
                <Icon name="boxes" size={16} color="var(--accent)" />
                <span className="stack-name">{s.name}</span>
                <Badge tone={tone}>{running}/{total} running</Badge>
                <span className="stack-meta mono">{s.file} · {s.branch} · {s.updated}</span>
                <span className="stack-actions" onClick={e => e.stopPropagation()}>
                  <Btn variant="ghost" size="sm" icon="rotate-ccw">Restart</Btn>
                  <Btn variant="ghost" size="sm" icon="square">Down</Btn>
                  <Btn variant="secondary" size="sm" icon="play">Up</Btn>
                </span>
              </div>
              {open[s.name] && (
                <div className="stack-body">
                  {s.services.map(svc => (
                    <div key={svc.name} className="stack-svc">
                      <span />
                      <Icon name="box" size={13} color="var(--fg-muted)" />
                      <span className="svc-name">{svc.name}</span>
                      <span className="svc-image mono">{svc.image}</span>
                      <Badge tone={svc.tone}>{svc.status}</Badge>
                      <span className="svc-rep mono">{svc.replicas}</span>
                      <button className="icon-btn ghost sm"><Icon name="ellipsis" size={13} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   BUILDS
   ========================================================================= */
const BUILDS = [
  { id: 'b8e2f1c', name: 'internal/api',    tag: '2026.05.25-a31f', status: 'Running',   tone: 'info',    progress: 68, step: '8 of 12', duration: '1m 04s', cache: '74%', by: 'mara@dockyard' },
  { id: 'b7d1e9b', name: 'internal/web',    tag: '2026.05.25-a31f', status: 'Succeeded', tone: 'running', progress: 100, step: '12 of 12', duration: '42s',    cache: '92%', by: 'mara@dockyard' },
  { id: 'b6c0d8a', name: 'internal/worker', tag: '42',              status: 'Failed',    tone: 'danger',  progress: 100, step: 'failed at 6 of 9', duration: '18s', cache: '0%',  by: 'kai@dockyard' },
  { id: 'b5bfc79', name: 'internal/ingest', tag: 'nightly',         status: 'Succeeded', tone: 'running', progress: 100, step: '10 of 10', duration: '2m 11s', cache: '64%', by: 'ci/nightly' },
  { id: 'b4aeb68', name: 'internal/api',    tag: '2026.05.24-c801', status: 'Succeeded', tone: 'running', progress: 100, step: '12 of 12', duration: '38s',    cache: '88%', by: 'ci/main' },
  { id: 'b39da57', name: 'internal/web',    tag: '2026.05.24-c801', status: 'Cancelled', tone: 'idle',    progress: 42, step: 'cancelled at 5 of 12', duration: '14s', cache: '50%', by: 'mara@dockyard' },
];

function BuildsPage() {
  const cols = '1.6fr 110px 110px 1fr 80px 80px 130px 36px';
  return (
    <div className="content-area">
      <PageHead
        title="Builds"
        count={BUILDS.length}
        actions={<>
          <Btn variant="ghost" icon="filter">Filter</Btn>
          <Btn variant="ghost" icon="settings-2">BuildKit</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="trash-2">Clear cache</Btn>
          <Btn variant="primary" icon="hammer">New build</Btn>
        </>}
      />
      <PageToolbar
        filters={[
          { id: 'all',    label: 'All',       count: BUILDS.length },
          { id: 'active', label: 'Running',   count: 1 },
          { id: 'failed', label: 'Failed',    count: 1 },
        ]}
        filter="all" setFilter={() => {}}
        right={<>cache: 6.4 GB · hit rate 78%</>}
      />
      <div className="gtable">
        <div className="gtable-head" style={{ gridTemplateColumns: cols }}>
          <span>Build</span>
          <span>Status</span>
          <span>Step</span>
          <span>Progress</span>
          <span>Duration</span>
          <span>Cache</span>
          <span>By</span>
          <span></span>
        </div>
        {BUILDS.map(b => (
          <div key={b.id} className="gtable-row" style={{ gridTemplateColumns: cols, alignItems: 'center' }}>
            <span className="col-name">
              <Icon name="hammer" size={14} color="var(--fg-muted)" />
              <span className="row-name">{b.name}</span>
              <span className="row-tag">:{b.tag}</span>
              <span className="row-id mono">{b.id}</span>
            </span>
            <span><Badge tone={b.tone}>{b.status}</Badge></span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>{b.step}</span>
            <span className="build-prog">
              <span className="build-track">
                <span className={`build-fill ${b.tone}`} style={{ width: `${b.progress}%` }} />
              </span>
              <span className="mono build-pct">{b.progress}%</span>
            </span>
            <span className="mono">{b.duration}</span>
            <span className="mono" style={{ color: b.cache === '0%' ? 'var(--danger-400)' : 'var(--fg-default)' }}>{b.cache}</span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>{b.by}</span>
            <span><button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   REGISTRY
   ========================================================================= */
const REGISTRIES = [
  { name: 'Docker Hub',     url: 'registry-1.docker.io',  type: 'public',  auth: 'token',  images: 38, status: 'connected' },
  { name: 'GitHub Container', url: 'ghcr.io',             type: 'private', auth: 'PAT',    images: 14, status: 'connected' },
  { name: 'AWS ECR',        url: '012345.dkr.ecr.us-east-1.amazonaws.com', type: 'private', auth: 'IAM', images: 22, status: 'connected' },
  { name: 'Internal',       url: 'registry.dockyard.io',  type: 'private', auth: 'mTLS',   images: 6,  status: 'unreachable' },
];

const RECENT_PULLS = [
  { image: 'internal/api:2026.05.25-a31f', registry: 'ghcr.io',                size: '218 MB', at: '12m ago', who: 'mara@dockyard' },
  { image: 'nginx:1.27.0',                 registry: 'docker.io',              size: '187 MB', at: '3h ago',  who: 'ci/main' },
  { image: 'postgres:16.2',                registry: 'docker.io',              size: '438 MB', at: '2d ago',  who: 'kai@dockyard' },
  { image: 'internal/worker:42',           registry: 'ghcr.io',                size: '156 MB', at: '1h ago',  who: 'ci/main' },
  { image: 'otel/collector:0.103',         registry: 'docker.io',              size: '124 MB', at: '4d ago',  who: 'platform-team' },
];

function RegistryPage() {
  return (
    <div className="content-area">
      <PageHead
        title="Registry"
        count={REGISTRIES.length}
        actions={<>
          <Btn variant="ghost" icon="settings">Credentials</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="search">Search images</Btn>
          <Btn variant="primary" icon="plus">Add registry</Btn>
        </>}
      />
      <div style={{ padding: '0 20px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <section>
          <div className="section-band">
            <span className="eyebrow">Connected registries</span>
            <span className="band-meta mono">last sync · 2m ago</span>
          </div>
          <div className="reg-grid">
            {REGISTRIES.map(r => (
              <div key={r.url} className={`reg-card ${r.status !== 'connected' ? 'is-down' : ''}`}>
                <div className="reg-top">
                  <Icon name="cloud" size={18} color={r.status === 'connected' ? 'var(--accent)' : 'var(--danger-400)'} />
                  <span className="reg-name">{r.name}</span>
                  <Badge tone={r.status === 'connected' ? 'running' : 'danger'}>
                    {r.status === 'connected' ? 'Connected' : 'Unreachable'}
                  </Badge>
                </div>
                <div className="reg-url mono">{r.url}</div>
                <div className="reg-meta">
                  <span className="mono"><span className="dim">type</span> {r.type}</span>
                  <span className="mono"><span className="dim">auth</span> {r.auth}</span>
                  <span className="mono"><span className="dim">images</span> {r.images}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="section-band">
            <span className="eyebrow">Recent pulls</span>
            <span className="band-meta mono">last 24h</span>
          </div>
          <div className="gtable" style={{ margin: 0 }}>
            <div className="gtable-head" style={{ gridTemplateColumns: '2fr 1fr 100px 110px 1fr' }}>
              <span>Image</span><span>Registry</span><span>Size</span><span>Pulled</span><span>By</span>
            </div>
            {RECENT_PULLS.map((p, i) => (
              <div key={i} className="gtable-row" style={{ gridTemplateColumns: '2fr 1fr 100px 110px 1fr' }}>
                <span className="col-name">
                  <Icon name="download" size={14} color="var(--fg-muted)" />
                  <span className="row-name mono">{p.image}</span>
                </span>
                <span className="mono" style={{ color: 'var(--fg-muted)' }}>{p.registry}</span>
                <span className="mono">{p.size}</span>
                <span className="mono" style={{ color: 'var(--fg-subtle)' }}>{p.at}</span>
                <span className="mono" style={{ color: 'var(--fg-muted)' }}>{p.who}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

Object.assign(window, { ComposePage, BuildsPage, RegistryPage });

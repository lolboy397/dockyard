/* global React, Icon, Btn, Badge, Dot, Chip */
const { useState: usePState } = React;

/* =========================================================================
   Shared shells
   ========================================================================= */
function PageHead({ title, count, total, actions, eyebrow }) {
  return (
    <div className="content-head">
      <div className="content-title-row">
        {eyebrow && <span className="eyebrow" style={{ marginRight: 8 }}>{eyebrow}</span>}
        <h2 className="content-title">{title}</h2>
        {(count != null) && <span className="content-count">{count}{total != null && ` of ${total}`}</span>}
      </div>
      <div className="content-actions">{actions}</div>
    </div>
  );
}

function PageToolbar({ filters, filter, setFilter, right }) {
  return (
    <div className="content-toolbar">
      <div className="pills">
        {filters.map(f => (
          <button key={f.id} className={`pill ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label}{f.count != null && <span className="pill-count">{f.count}</span>}
          </button>
        ))}
      </div>
      <div className="toolbar-meta mono">{right}</div>
    </div>
  );
}

function GTable({ cols, children }) {
  return (
    <div className="gtable">
      <div className="gtable-head" style={{ gridTemplateColumns: cols }}>
        {/* head children rendered separately */}
      </div>
      {children}
    </div>
  );
}

/* =========================================================================
   IMAGES
   ========================================================================= */
const IMAGES = [
  { name: 'nginx',                 tag: '1.27.0',      size: '187 MB',  layers: 7,  used: 2, pulled: '3h ago',  digest: 'sha256:a1b2c3d4e5f6' },
  { name: 'postgres',              tag: '16.2',        size: '438 MB',  layers: 14, used: 1, pulled: '2d ago',  digest: 'sha256:g7h8i9j0k1l2' },
  { name: 'redis',                 tag: '7.2-alpine',  size: '41 MB',   layers: 5,  used: 1, pulled: '5d ago',  digest: 'sha256:m3n4o5p6q7r8' },
  { name: 'internal/api',          tag: '2026.05',     size: '218 MB',  layers: 12, used: 1, pulled: '12m ago', digest: 'sha256:s9t0u1v2w3x4' },
  { name: 'internal/web',          tag: '2026.05',     size: '94 MB',   layers: 9,  used: 1, pulled: '12m ago', digest: 'sha256:y5z6a7b8c9d0' },
  { name: 'internal/worker',       tag: '42',          size: '156 MB',  layers: 10, used: 1, pulled: '1h ago',  digest: 'sha256:e1f2g3h4i5j6' },
  { name: 'rabbitmq',              tag: '3.13-mgmt',   size: '258 MB',  layers: 11, used: 1, pulled: '6d ago',  digest: 'sha256:k7l8m9n0o1p2' },
  { name: 'otel/collector',        tag: '0.103',       size: '124 MB',  layers: 8,  used: 1, pulled: '4d ago',  digest: 'sha256:q3r4s5t6u7v8' },
  { name: 'busybox',               tag: 'latest',      size: '4.2 MB',  layers: 1,  used: 0, pulled: '8d ago',  digest: 'sha256:w9x0y1z2a3b4' },
  { name: 'mailhog/mailhog',       tag: 'latest',      size: '79 MB',   layers: 6,  used: 0, pulled: '14d ago', digest: 'sha256:c5d6e7f8g9h0' },
];

function ImagesPage() {
  const [filter, setFilter] = usePState('all');
  const [selected, setSelected] = usePState(IMAGES[3].digest);
  const cols = '36px 1.7fr 90px 70px 90px 100px 36px';
  const rows = IMAGES.filter(i => filter === 'all' || (filter === 'used' ? i.used > 0 : i.used === 0));

  return (
    <div className="content-area">
      <PageHead
        title="Images"
        count={rows.length} total={IMAGES.length}
        actions={<>
          <Btn variant="ghost" icon="filter">Filter</Btn>
          <Btn variant="ghost" icon="trash-2">Prune…</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="hammer">Build</Btn>
          <Btn variant="primary" icon="download">Pull image</Btn>
        </>}
      />
      <PageToolbar
        filters={[
          { id: 'all',    label: 'All',    count: IMAGES.length },
          { id: 'used',   label: 'In use', count: IMAGES.filter(i => i.used > 0).length },
          { id: 'unused', label: 'Unused', count: IMAGES.filter(i => i.used === 0).length },
        ]}
        filter={filter} setFilter={setFilter}
        right={<>1.6 GB total · 198 MB reclaimable</>}
      />
      <div className="gtable">
        <div className="gtable-head" style={{ gridTemplateColumns: cols }}>
          <span><input type="checkbox" /></span>
          <span>Repository : tag</span>
          <span>Size</span>
          <span>Layers</span>
          <span>Used by</span>
          <span>Pulled</span>
          <span></span>
        </div>
        {rows.map(img => (
          <div
            key={img.digest}
            className={`gtable-row ${selected === img.digest ? 'sel' : ''}`}
            style={{ gridTemplateColumns: cols }}
            onClick={() => setSelected(img.digest)}
          >
            <span onClick={e => e.stopPropagation()}><input type="checkbox" /></span>
            <span className="col-name">
              <Icon name="layers" size={14} color="var(--fg-muted)" />
              <span className="row-name">{img.name}</span>
              <span className="row-tag">:{img.tag}</span>
              <span className="row-id mono">{img.digest.slice(7, 19)}</span>
            </span>
            <span className="mono">{img.size}</span>
            <span className="mono">{img.layers}</span>
            <span className="mono">
              {img.used > 0
                ? <span style={{ color: 'var(--fg-default)' }}>{img.used} container{img.used > 1 ? 's' : ''}</span>
                : <span style={{ color: 'var(--fg-subtle)' }}>—</span>}
            </span>
            <span className="mono" style={{ color: 'var(--fg-subtle)' }}>{img.pulled}</span>
            <span onClick={e => e.stopPropagation()}>
              <button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   VOLUMES
   ========================================================================= */
const VOLUMES = [
  { name: 'pgdata',         driver: 'local', mount: '/var/lib/postgresql/data', size: '2.1 GB',  used: 'postgres-main',     created: '24d ago' },
  { name: 'nginx-config',   driver: 'local', mount: '/etc/nginx/conf.d',         size: '12 KB',   used: 'nginx-prod',        created: '24d ago' },
  { name: 'nginx-logs',     driver: 'local', mount: '/var/log/nginx',            size: '184 MB',  used: 'nginx-prod',        created: '24d ago' },
  { name: 'redis-data',     driver: 'local', mount: '/data',                     size: '128 MB',  used: 'cache',             created: '24d ago' },
  { name: 'rabbitmq-data',  driver: 'local', mount: '/var/lib/rabbitmq',         size: '48 MB',   used: 'queue-broker',      created: '14d ago' },
  { name: 'metrics-store',  driver: 'local', mount: '/data/metrics',             size: '1.2 GB',  used: 'metrics-otel',      created: '6d ago' },
  { name: 'shared-tmp',     driver: 'local', mount: '/tmp/shared',               size: '34 MB',   used: null,                created: '2d ago' },
  { name: 'old-backup-04',  driver: 'nfs',   mount: '/mnt/backup',               size: '8.7 GB',  used: null,                created: '90d ago' },
  { name: 'old-pgdata-v15', driver: 'local', mount: '/var/lib/postgresql/data',  size: '1.8 GB',  used: null,                created: '180d ago' },
];

function VolumesPage() {
  const [filter, setFilter] = usePState('all');
  const cols = '36px 1.3fr 70px 1.5fr 80px 1fr 90px 36px';
  const rows = VOLUMES.filter(v => filter === 'all' || (filter === 'used' ? v.used : !v.used));

  return (
    <div className="content-area">
      <PageHead
        title="Volumes"
        count={rows.length} total={VOLUMES.length}
        actions={<>
          <Btn variant="ghost" icon="trash-2">Prune unused</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="camera">Snapshot</Btn>
          <Btn variant="primary" icon="plus">New volume</Btn>
        </>}
      />
      <PageToolbar
        filters={[
          { id: 'all',    label: 'All',     count: VOLUMES.length },
          { id: 'used',   label: 'In use',  count: VOLUMES.filter(v => v.used).length },
          { id: 'unused', label: 'Orphaned',count: VOLUMES.filter(v => !v.used).length },
        ]}
        filter={filter} setFilter={setFilter}
        right={<>14.4 GB total · 10.5 GB reclaimable</>}
      />
      <div className="gtable">
        <div className="gtable-head" style={{ gridTemplateColumns: cols }}>
          <span><input type="checkbox" /></span>
          <span>Name</span>
          <span>Driver</span>
          <span>Mount</span>
          <span>Size</span>
          <span>In use by</span>
          <span>Created</span>
          <span></span>
        </div>
        {rows.map(v => (
          <div key={v.name} className="gtable-row" style={{ gridTemplateColumns: cols }}>
            <span onClick={e => e.stopPropagation()}><input type="checkbox" /></span>
            <span className="col-name">
              <Icon name="database" size={14} color="var(--fg-muted)" />
              <span className="row-name">{v.name}</span>
            </span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>{v.driver}</span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>{v.mount}</span>
            <span className="mono">{v.size}</span>
            <span className="mono">
              {v.used
                ? <span style={{ color: 'var(--fg-default)' }}>{v.used}</span>
                : <Badge tone="warn">Orphaned</Badge>}
            </span>
            <span className="mono" style={{ color: 'var(--fg-subtle)' }}>{v.created}</span>
            <span><button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   NETWORKS
   ========================================================================= */
const NETWORKS = [
  { name: 'bridge',          driver: 'bridge',  scope: 'local', subnet: '172.17.0.0/16', gateway: '172.17.0.1', containers: 6,  internal: false, system: true },
  { name: 'host',            driver: 'host',    scope: 'local', subnet: '—',             gateway: '—',          containers: 0,  internal: false, system: true },
  { name: 'none',            driver: 'null',    scope: 'local', subnet: '—',             gateway: '—',          containers: 0,  internal: false, system: true },
  { name: 'app-net',         driver: 'bridge',  scope: 'local', subnet: '10.20.0.0/24',  gateway: '10.20.0.1',  containers: 5,  internal: false, system: false },
  { name: 'data-net',        driver: 'bridge',  scope: 'local', subnet: '10.30.0.0/24',  gateway: '10.30.0.1',  containers: 3,  internal: true,  system: false },
  { name: 'ingress-overlay', driver: 'overlay', scope: 'swarm', subnet: '10.0.0.0/24',   gateway: '10.0.0.1',   containers: 4,  internal: false, system: false },
];

function NetworksPage() {
  const cols = '36px 1.3fr 90px 70px 1.1fr 1fr 80px 36px';
  return (
    <div className="content-area">
      <PageHead
        title="Networks"
        count={NETWORKS.length}
        actions={<>
          <Btn variant="ghost" icon="filter">Filter</Btn>
          <Btn variant="ghost" icon="trash-2">Prune unused</Btn>
          <span className="divider-v" />
          <Btn variant="secondary" icon="git-fork">Topology</Btn>
          <Btn variant="primary" icon="plus">New network</Btn>
        </>}
      />
      <PageToolbar
        filters={[
          { id: 'all',    label: 'All',     count: NETWORKS.length },
          { id: 'user',   label: 'User',    count: NETWORKS.filter(n => !n.system).length },
          { id: 'system', label: 'System',  count: NETWORKS.filter(n => n.system).length },
        ]}
        filter="all" setFilter={() => {}}
        right={<>3 drivers · 18 endpoints</>}
      />
      <div className="gtable">
        <div className="gtable-head" style={{ gridTemplateColumns: cols }}>
          <span><input type="checkbox" /></span>
          <span>Name</span>
          <span>Driver</span>
          <span>Scope</span>
          <span>Subnet</span>
          <span>Gateway</span>
          <span>Containers</span>
          <span></span>
        </div>
        {NETWORKS.map(n => (
          <div key={n.name} className="gtable-row" style={{ gridTemplateColumns: cols }}>
            <span><input type="checkbox" /></span>
            <span className="col-name">
              <Icon name="network" size={14} color="var(--fg-muted)" />
              <span className="row-name">{n.name}</span>
              {n.system && <span className="mini-tag">system</span>}
              {n.internal && <span className="mini-tag">internal</span>}
            </span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>{n.driver}</span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>{n.scope}</span>
            <span className="mono">{n.subnet}</span>
            <span className="mono" style={{ color: 'var(--fg-muted)' }}>{n.gateway}</span>
            <span className="mono">
              {n.containers > 0
                ? <span style={{ color: 'var(--fg-default)' }}>{n.containers}</span>
                : <span style={{ color: 'var(--fg-subtle)' }}>0</span>}
            </span>
            <span><button className="icon-btn ghost sm"><Icon name="ellipsis" size={14} /></button></span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { ImagesPage, VolumesPage, NetworksPage, PageHead, PageToolbar });

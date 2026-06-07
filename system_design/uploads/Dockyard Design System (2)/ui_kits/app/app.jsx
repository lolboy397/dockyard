/* global React, ReactDOM, Sidebar, TopBar, ContainerTable, DetailPanel, StatusBar, CommandPalette, ImagesPage, VolumesPage, NetworksPage, ComposePage, BuildsPage, RegistryPage, LogsPage, MetricsPage, EventsPage, ProjectsPage, Dashboard */

const { useState, useEffect } = React;

const SECTION_LABELS = {
  dashboard: 'Dashboard', projects: 'Projects', containers: 'Containers',
  images: 'Images', volumes: 'Volumes', networks: 'Networks',
  compose: 'Compose', builds: 'Builds', registry: 'Registry',
  logs: 'Logs', metrics: 'Metrics', events: 'Events',
};

const CONTAINERS = [
  { id: 'a1b2c3d', name: 'nginx-prod',      image: 'nginx:1.27.0',         status: 'Running',    statusGroup: 'running', tone: 'running', ports: ':8080→80',     cpu: '0.4%',  mem: '24 MB',   started: '3m ago' },
  { id: 'e4f5g6h', name: 'postgres-main',   image: 'postgres:16.2',        status: 'Running',    statusGroup: 'running', tone: 'running', ports: ':5432→5432',   cpu: '2.1%',  mem: '412 MB',  started: '2h ago' },
  { id: 'i7j8k9l', name: 'worker-jobs',     image: 'internal/worker:42',   status: 'Restarting', statusGroup: 'running', tone: 'warn',    ports: '—',            cpu: '0.0%',  mem: '8 MB',    started: '12s ago' },
  { id: 'm0n1o2p', name: 'cache',           image: 'redis:7.2-alpine',     status: 'Exited',     statusGroup: 'stopped', tone: 'idle',    ports: '—',            cpu: '—',     mem: '—',       started: '1d ago' },
  { id: 'q3r4s5t', name: 'api-prod',        image: 'internal/api:2026.05', status: 'Running',    statusGroup: 'running', tone: 'running', ports: ':3000→3000',   cpu: '4.7%',  mem: '186 MB',  started: '4h ago' },
  { id: 'u6v7w8x', name: 'web-prod',        image: 'internal/web:2026.05', status: 'Running',    statusGroup: 'running', tone: 'running', ports: ':80→80',       cpu: '0.8%',  mem: '92 MB',   started: '4h ago' },
  { id: 'y9z0a1b', name: 'queue-broker',    image: 'rabbitmq:3.13-mgmt',   status: 'Running',    statusGroup: 'running', tone: 'running', ports: ':5672, :15672', cpu: '0.2%',  mem: '128 MB',  started: '1h ago' },
  { id: 'c2d3e4f', name: 'mailhog',         image: 'mailhog/mailhog',      status: 'Exited',     statusGroup: 'stopped', tone: 'idle',    ports: '—',            cpu: '—',     mem: '—',       started: '3d ago' },
  { id: 'g5h6i7j', name: 'ingest-staging',  image: 'internal/ingest:nightly', status: 'Crashed', statusGroup: 'stopped', tone: 'danger',  ports: '—',            cpu: '—',     mem: '—',       started: '8m ago' },
  { id: 'k8l9m0n', name: 'metrics-otel',    image: 'otel/collector:0.103', status: 'Running',    statusGroup: 'running', tone: 'running', ports: ':4317, :4318', cpu: '0.6%',  mem: '54 MB',   started: '6h ago' },
];

function EmptySection({ title, body }) {
  return (
    <div className="empty-section">
      <span className="eyebrow">{title}</span>
      <div className="ti">Recreation in progress</div>
      <div className="body">{body}</div>
    </div>
  );
}

function App() {
  const [section, setSection] = useState('dashboard');
  const [selectedId, setSelectedId] = useState('a1b2c3d');
  const [filter, setFilter] = useState('all');
  const [palette, setPalette] = useState(false);

  // ⌘K / Ctrl+K
  useEffect(() => {
    const fn = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(p => !p);
      } else if (e.key === 'Escape' && palette) {
        setPalette(false);
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [palette]);

  const selected = CONTAINERS.find(c => c.id === selectedId);
  const showDetail = section === 'containers' && selected;

  const counts = {
    containers: CONTAINERS.length,
    images: 38,
    volumes: 9,
    networks: 4,
    projects: 6,
  };

  return (
    <div className="app">
      <Sidebar section={section} setSection={setSection} counts={counts} />
      <div className="main">
        <TopBar onOpenPalette={() => setPalette(true)} crumb={SECTION_LABELS[section]} />
        <div className={`body ${showDetail ? '' : 'no-detail'}`}>
          {section === 'dashboard' && <Dashboard />}
          {section === 'projects'  && <ProjectsPage />}
          {section === 'containers' && (
            <ContainerTable
              rows={CONTAINERS}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              filter={filter}
              setFilter={setFilter}
            />
          )}
          {section === 'images'   && <ImagesPage />}
          {section === 'volumes'  && <VolumesPage />}
          {section === 'networks' && <NetworksPage />}
          {section === 'compose'  && <ComposePage />}
          {section === 'builds'   && <BuildsPage />}
          {section === 'registry' && <RegistryPage />}
          {section === 'logs'     && <LogsPage />}
          {section === 'metrics'  && <MetricsPage />}
          {section === 'events'   && <EventsPage />}
          {showDetail && <DetailPanel container={selected} onClose={() => setSelectedId(null)} />}
        </div>
      </div>
      <StatusBar />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

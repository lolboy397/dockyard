/* global React, ReactDOM, SetupWizard, LoginScreen, Icon */
const { useState: useAppState, useEffect: useAppEffect } = React;

const DEFAULT_DATA = {
  // welcome
  accepted: false,
  // admin
  fullName: '', email: '', username: '', password: '', confirm: '',
  // instance
  instanceName: 'production', dockerHost: '/var/run/docker.sock',
  dataDir: '/var/lib/dockyard', bindAddr: '0.0.0.0:9443',
  // prefs
  tls: true, autoUpdate: true, telemetry: false, registry: 'docker.io',
};

function Root() {
  // mode: 'setup' (first run) or 'login'. Persisted so refresh keeps your place.
  const [mode, setMode] = useAppState(() => localStorage.getItem('dy_auth_mode') || 'setup');
  const [data, setData] = useAppState(DEFAULT_DATA);
  const [completedUser, setCompletedUser] = useAppState(null);

  useAppEffect(() => { localStorage.setItem('dy_auth_mode', mode); }, [mode]);

  const onSetupFinish = () => {
    setCompletedUser(data.username || 'admin');
    setMode('login');
  };

  return (
    <div className="stage" data-screen-label={mode === 'setup' ? 'First-run setup' : 'Login'}>
      <div className="stage-grid" />
      <DockyardBackground />

      {mode === 'setup'
        ? <SetupWizard data={data} setData={setData} onFinish={onSetupFinish} />
        : <LoginScreen knownUser={completedUser} onSignedIn={() => {}} />}

      {/* prototype affordance: jump between the two screens */}
      <div className="modeswitch">
        <span className="ms-label">view</span>
        <div className="segmented">
          <button className={`seg-btn ${mode === 'setup' ? 'on' : ''}`} onClick={() => setMode('setup')}>
            <Icon name="rocket" size={13} /> First-run setup
          </button>
          <button className={`seg-btn ${mode === 'login' ? 'on' : ''}`} onClick={() => setMode('login')}>
            <Icon name="log-in" size={13} /> Login
          </button>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Root />);

/* global React, Icon, Dot */

function StatusBar() {
  return (
    <footer className="statusbar">
      <div className="status-group">
        <span className="status-item"><Dot tone="running" /> engine running · 26.1.4</span>
        <span className="status-item mono">cpu 12%</span>
        <span className="status-item mono">mem 8.4 / 16 GB</span>
        <span className="status-item mono">disk 218 / 244 GB</span>
      </div>
      <div className="status-group">
        <span className="status-item mono">14 containers · 38 images</span>
        <span className="status-item mono">api.dockyard.io</span>
        <span className="status-item">v2.1.0</span>
      </div>
    </footer>
  );
}

Object.assign(window, { StatusBar });

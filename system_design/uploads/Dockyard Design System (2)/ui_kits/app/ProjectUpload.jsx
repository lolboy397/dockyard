/* global React, Icon, Btn, Badge */
const { useState: useUpState } = React;

const PREVIEW_TREE = [
  { name: 'src', type: 'dir', open: true, children: [
    { name: 'index.ts', type: 'file', lang: 'ts' },
    { name: 'server.ts', type: 'file', lang: 'ts' },
    { name: 'routes', type: 'dir', children: [
      { name: 'jobs.ts', type: 'file', lang: 'ts' },
    ]},
  ]},
  { name: 'Dockerfile', type: 'file', lang: 'docker', key: true },
  { name: 'package.json', type: 'file', lang: 'json', key: true },
  { name: 'tsconfig.json', type: 'file', lang: 'json' },
  { name: '.dockerignore', type: 'file', lang: 'text' },
];

function UpTreeNode({ node, depth }) {
  const [open, setOpen] = useUpState(!!node.open);
  const pad = { paddingLeft: 8 + depth * 14 };
  const LANG_ICON = { ts: 'file-code', json: 'braces', docker: 'container', text: 'file' };
  if (node.type === 'dir') {
    return (
      <>
        <div className="tree-row tree-dir" style={pad} onClick={() => setOpen(o => !o)}>
          <Icon name="chevron-right" size={11} className={`tree-chev ${open ? 'open' : ''}`} color="var(--fg-subtle)" />
          <Icon name={open ? 'folder-open' : 'folder'} size={13} color="var(--accent)" />
          <span className="tree-name">{node.name}</span>
        </div>
        {open && node.children.map((c, i) => <UpTreeNode key={i} node={c} depth={depth + 1} />)}
      </>
    );
  }
  return (
    <div className={`tree-row tree-file ${node.key ? 'is-key' : ''}`} style={pad}>
      <span className="tree-chev-spacer" style={{ width: 11 }} />
      <Icon name={LANG_ICON[node.lang] || 'file'} size={12} color={node.key ? 'var(--accent)' : 'var(--fg-muted)'} />
      <span className="tree-name">{node.name}</span>
    </div>
  );
}

function UploadModal({ onClose }) {
  const [step, setStep] = useUpState(1);
  const [dragging, setDragging] = useUpState(false);
  const [ports, setPorts] = useUpState([{ host: '3000', container: '3000' }]);

  const addPort = () => setPorts(p => [...p, { host: '', container: '' }]);
  const removePort = (i) => setPorts(p => p.filter((_, idx) => idx !== i));
  const updatePort = (i, k, v) => setPorts(p => p.map((x, idx) => idx === i ? { ...x, [k]: v } : x));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="upload-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <Icon name="upload-cloud" size={16} color="var(--accent)" />
            <span>New project</span>
            <div className="modal-steps">
              <span className={`mstep ${step === 1 ? 'on' : 'done'}`}>1 · Upload</span>
              <span className="mstep-line" />
              <span className={`mstep ${step === 2 ? 'on' : ''}`}>2 · Configure</span>
            </div>
          </div>
          <button className="icon-btn ghost" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>

        {/* STEP 1 — drop zone */}
        {step === 1 && (
          <div className="modal-body">
            <div
              className={`dropzone ${dragging ? 'dragging' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); setStep(2); }}
              onClick={() => setStep(2)}
            >
              <div className="dropzone-icon"><Icon name="upload-cloud" size={32} color="var(--accent)" /></div>
              <div className="dropzone-title">Drop a folder or .zip archive</div>
              <div className="dropzone-sub">or <span className="dropzone-link">browse your computer</span></div>
              <div className="dropzone-hint mono">Dockyard auto-detects Dockerfile and Compose projects</div>
            </div>
            <div className="dropzone-accepts">
              <span className="accept-chip"><Icon name="file-code" size={12} /> Dockerfile</span>
              <span className="accept-chip"><Icon name="boxes" size={12} /> docker-compose.yml</span>
              <span className="accept-chip"><Icon name="folder" size={12} /> Source folder</span>
              <span className="accept-chip"><Icon name="file-archive" size={12} /> .zip / .tar.gz</span>
            </div>
          </div>
        )}

        {/* STEP 2 — preview + form */}
        {step === 2 && (
          <div className="modal-body modal-body-2">
            <div className="preview-left">
              <div className="detect-banner">
                <Icon name="file-code" size={16} color="var(--accent)" />
                <div>
                  <div className="detect-banner-title">Dockerfile project detected</div>
                  <div className="detect-banner-sub mono">jobs-api.zip · 1.4 MB · 12 files</div>
                </div>
                <Badge tone="running">Ready</Badge>
              </div>

              <div className="preview-section">
                <div className="preview-label">Key files</div>
                <div className="keyfiles">
                  <span className="keyfile"><Icon name="file-code" size={12} color="var(--accent)" /> Dockerfile</span>
                  <span className="keyfile"><Icon name="braces" size={12} color="var(--accent)" /> package.json</span>
                  <span className="keyfile"><Icon name="file-text" size={12} color="var(--fg-muted)" /> README.md</span>
                </div>
              </div>

              <div className="preview-section preview-tree-section">
                <div className="preview-label">Source tree</div>
                <div className="preview-tree">
                  {PREVIEW_TREE.map((n, i) => <UpTreeNode key={i} node={n} depth={0} />)}
                </div>
              </div>
            </div>

            <div className="preview-right">
              <div className="form-field">
                <label className="form-label">Project name</label>
                <input className="form-input" defaultValue="jobs-api" />
              </div>
              <div className="form-field">
                <label className="form-label">Description</label>
                <input className="form-input" placeholder="What does this project do?" defaultValue="Background job processing API · Node + Postgres" />
              </div>
              <div className="form-field">
                <label className="form-label">Port mappings</label>
                <div className="port-mappings">
                  {ports.map((p, i) => (
                    <div className="port-map-row" key={i}>
                      <input className="form-input mono" placeholder="host" value={p.host} onChange={e => updatePort(i, 'host', e.target.value)} />
                      <Icon name="arrow-right" size={13} color="var(--fg-subtle)" />
                      <input className="form-input mono" placeholder="container" value={p.container} onChange={e => updatePort(i, 'container', e.target.value)} />
                      <button className="icon-btn ghost sm" onClick={() => removePort(i)}><Icon name="x" size={12} /></button>
                    </div>
                  ))}
                  <button className="add-port" onClick={addPort}><Icon name="plus" size={12} /> Add port mapping</button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="modal-foot">
          {step === 2 && <Btn variant="ghost" icon="arrow-left" onClick={() => setStep(1)}>Back</Btn>}
          <span style={{ flex: 1 }} />
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          {step === 1
            ? <Btn variant="secondary" onClick={() => setStep(2)}>Skip to demo →</Btn>
            : <Btn variant="primary" icon="hammer" onClick={onClose}>Create & build</Btn>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { UploadModal });

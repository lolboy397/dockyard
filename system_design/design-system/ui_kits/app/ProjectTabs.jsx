/* global React, Icon, Btn, Badge, Dot, DIFF_SAMPLE */
const { useState: useTabState } = React;

/* =========================================================================
   LOGS TAB — build + run log viewers, inline port-conflict resolution
   ========================================================================= */
function ProjectLogsTab({ project, setStatus }) {
  const [view, setView] = useTabState(project.status === 'running' ? 'run' : 'build');
  const [conflictResolved, setConflictResolved] = useTabState(false);
  const buildLog = project.buildLog || [];
  const runLog = project.runLog || [];

  return (
    <div className="logs-tab">
      <div className="logs-tab-toolbar">
        <div className="pills sm">
          <button className={`pill ${view === 'build' ? 'on' : ''}`} onClick={() => setView('build')}>
            Build log {buildLog.length > 0 && <span className="pill-count">{buildLog.length}</span>}
          </button>
          <button className={`pill ${view === 'run' ? 'on' : ''}`} onClick={() => setView('run')}>
            Run log {runLog.length > 0 && <span className="pill-count">{runLog.length}</span>}
          </button>
        </div>
        <div className="logs-tab-actions">
          {view === 'build' && project.status === 'building' &&
            <span className="logs-live mono"><Dot tone="warn" /> building · step {project.buildStep}</span>}
          {view === 'run' && project.status === 'running' &&
            <span className="logs-live mono"><Dot tone="running" /> live</span>}
          <button className="icon-btn ghost sm" title="Download"><Icon name="download" size={13} /></button>
          <button className="icon-btn ghost sm" title="Wrap"><Icon name="wrap-text" size={13} /></button>
        </div>
      </div>

      {/* BUILD LOG */}
      {view === 'build' && (
        <div className="logwell">
          {buildLog.length === 0 && <div className="logwell-empty mono">No build has run yet. Press <strong>Build</strong> to start.</div>}
          {buildLog.map(([lvl, text], i) => (
            <div className="build-line" key={i}>
              <span className={`build-mark mark-${lvl.toLowerCase()}`}>
                {lvl === 'OK' ? '✓' : lvl === 'DIM' ? ' ' : '›'}
              </span>
              <span className={`build-text ${lvl === 'DIM' ? 'dim' : ''} ${lvl === 'OK' ? 'ok' : ''}`}>{text}</span>
            </div>
          ))}
          {project.status === 'building' && (
            <div className="build-line"><span className="build-mark mark-info">›</span><span className="build-text">building… <span className="cursor" style={{ width: 5, height: 11 }} /></span></div>
          )}
        </div>
      )}

      {/* RUN LOG */}
      {view === 'run' && (
        <>
          {/* inline port conflict resolution */}
          {project.portConflict && !conflictResolved && (
            <div className="inline-conflict">
              <div className="inline-conflict-head">
                <Icon name="triangle-alert" size={14} color="var(--danger-400)" />
                <span>Run failed — port <span className="mono">{project.portConflict.host}</span> in use by <span className="mono">{project.portConflict.by}</span></span>
              </div>
              <div className="inline-conflict-body">
                <div className="conflict-opt">
                  <input type="radio" name="resolve" defaultChecked id="remap" />
                  <label htmlFor="remap">Remap host port to
                    <input className="port-input mono" defaultValue={project.portConflict.host + 1} style={{ width: 64, margin: '0 6px' }} />
                    <span className="mono" style={{ color: 'var(--fg-subtle)' }}>→ {project.portConflict.host}</span>
                  </label>
                </div>
                <div className="conflict-opt">
                  <input type="radio" name="resolve" id="stopother" />
                  <label htmlFor="stopother">Stop <span className="mono">{project.portConflict.by}</span> and reuse the port</label>
                </div>
                <Btn variant="primary" size="sm" icon="check" onClick={() => { setConflictResolved(true); setStatus && setStatus(project.id, { status: 'running', portConflict: null }); }}>
                  Resolve & run
                </Btn>
              </div>
            </div>
          )}
          <div className="logwell">
            {runLog.length === 0 && !project.portConflict &&
              <div className="logwell-empty mono">Container is not running. Press <strong>Run</strong> to start streaming logs.</div>}
            {runLog.map(([ts, lvl, msg], i) => (
              <div className="lline" key={i}>
                <span className="lts">{ts}</span>
                <span className={`llvl lvl-${lvl.trim().toLowerCase()}`}>{lvl.padEnd(4)}</span>
                <span className="lmsg">{msg}</span>
              </div>
            ))}
            {project.status === 'running' && runLog.length > 0 &&
              <div className="lline"><span className="cursor" style={{ width: 5, height: 11 }} /></div>}
          </div>
        </>
      )}
    </div>
  );
}

/* =========================================================================
   FILES TAB — collapsible tree + preview
   ========================================================================= */
const LANG_ICON = {
  ts: 'file-code', tsx: 'file-code', js: 'file-code', json: 'braces',
  sql: 'database', docker: 'container', yaml: 'settings-2', css: 'palette',
  md: 'file-text', text: 'file', html: 'file-code',
};

function TreeNode({ node, depth }) {
  const [open, setOpen] = useTabState(!!node.open);
  const pad = { paddingLeft: 10 + depth * 16 };
  if (node.type === 'dir') {
    return (
      <>
        <div className="tree-row tree-dir" style={pad} onClick={() => setOpen(o => !o)}>
          <Icon name="chevron-right" size={12} className={`tree-chev ${open ? 'open' : ''}`} color="var(--fg-subtle)" />
          <Icon name={open ? 'folder-open' : 'folder'} size={14} color="var(--accent)" />
          <span className="tree-name">{node.name}</span>
        </div>
        {open && node.children.map((c, i) => <TreeNode key={i} node={c} depth={depth + 1} />)}
      </>
    );
  }
  return (
    <div className={`tree-row tree-file ${node.key ? 'is-key' : ''}`} style={pad}>
      <span className="tree-chev-spacer" />
      <Icon name={LANG_ICON[node.lang] || 'file'} size={13} color={node.key ? 'var(--accent)' : 'var(--fg-muted)'} />
      <span className="tree-name">{node.name}</span>
      {node.change && <span className={`tree-change tc-${node.change}`}>{node.change}</span>}
      {node.lines != null && <span className="tree-lines mono">{node.lines}</span>}
    </div>
  );
}

function ProjectFilesTab({ project }) {
  return (
    <div className="files-tab">
      <div className="files-toolbar">
        <div className="files-search">
          <Icon name="search" size={13} color="var(--fg-muted)" />
          <input placeholder="Find file…" />
        </div>
        <span className="mono files-meta">{project.type === 'Compose' ? 'compose.yml' : 'Dockerfile'} detected · {countFiles(project.files)} files</span>
      </div>
      <div className="files-body">
        <div className="files-tree">
          {project.files.map((n, i) => <TreeNode key={i} node={n} depth={0} />)}
        </div>
        <div className="files-preview">
          <div className="files-preview-head">
            <Icon name="file-code" size={13} color="var(--accent)" />
            <span className="mono">{project.type === 'Compose' ? 'compose.yml' : 'Dockerfile'}</span>
            <span className="files-preview-spacer" />
            <button className="icon-btn ghost sm"><Icon name="copy" size={12} /></button>
          </div>
          <pre className="files-code">{project.type === 'Compose' ? COMPOSE_SAMPLE : DOCKERFILE_SAMPLE}</pre>
        </div>
      </div>
    </div>
  );
}

function countFiles(tree) {
  let n = 0;
  const walk = (nodes) => nodes.forEach(x => x.type === 'dir' ? walk(x.children) : n++);
  walk(tree);
  return n;
}

const DOCKERFILE_SAMPLE = `FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]`;

const COMPOSE_SAMPLE = `services:
  web:
    build: .
    ports:
      - "80:3000"
      - "443:3443"
    environment:
      NODE_ENV: production
    depends_on:
      - cache
  cache:
    image: redis:7.2-alpine
    volumes:
      - redis-data:/data
volumes:
  redis-data:`;

/* =========================================================================
   SOURCE TAB — lightweight git
   ========================================================================= */
function ProjectSourceTab({ project }) {
  const git = project.git;
  const [staged, setStaged] = useTabState(git.staged);
  const [unstaged, setUnstaged] = useTabState(git.unstaged);
  const [selected, setSelected] = useTabState(git.staged[0] || git.unstaged[0] || null);
  const [showAuthor, setShowAuthor] = useTabState(false);
  const [branchOpen, setBranchOpen] = useTabState(false);

  const stageFile = (f) => { setUnstaged(u => u.filter(x => x.path !== f.path)); setStaged(s => [...s, f]); };
  const unstageFile = (f) => { setStaged(s => s.filter(x => x.path !== f.path)); setUnstaged(u => [...u, f]); };

  return (
    <div className="source-tab">
      {/* git toolbar */}
      <div className="git-toolbar">
        <div className="git-branch-picker" onClick={() => setBranchOpen(o => !o)}>
          <Icon name="git-branch" size={13} color="var(--accent)" />
          <span className="mono">{git.branch}</span>
          <Icon name="chevrons-up-down" size={12} color="var(--fg-subtle)" />
          {branchOpen && (
            <div className="branch-menu" onClick={e => e.stopPropagation()}>
              <div className="branch-menu-label">Switch branch</div>
              {git.branches.map(b => (
                <div key={b} className={`branch-item ${b === git.branch ? 'on' : ''}`}>
                  <Icon name={b === git.branch ? 'check' : 'git-branch'} size={12} />
                  <span className="mono">{b}</span>
                </div>
              ))}
              <div className="branch-menu-sep" />
              <div className="branch-item"><Icon name="plus" size={12} /> New branch…</div>
            </div>
          )}
        </div>
        <div className="git-sync mono">
          <span title="ahead"><Icon name="arrow-up" size={11} /> {git.ahead}</span>
          <span title="behind"><Icon name="arrow-down" size={11} /> {git.behind}</span>
        </div>
        <div className="git-toolbar-actions">
          <Btn variant="ghost" size="sm" icon="rotate-cw">Fetch</Btn>
          <Btn variant="ghost" size="sm" icon="arrow-down-to-line">Pull</Btn>
          <Btn variant="secondary" size="sm" icon="arrow-up-from-line">Push{git.ahead > 0 ? ` (${git.ahead})` : ''}</Btn>
        </div>
      </div>
      <div className="git-remote mono"><Icon name="cloud" size={11} /> {git.remote}</div>

      <div className="source-body">
        {/* left: changes + commit */}
        <div className="git-left">
          <div className="git-changes">
            <ChangeGroup title="Staged changes" count={staged.length} files={staged} selected={selected} onSelect={setSelected} action="unstage" onAction={unstageFile} />
            <ChangeGroup title="Changes" count={unstaged.length} files={unstaged} selected={selected} onSelect={setSelected} action="stage" onAction={stageFile} />
            {staged.length + unstaged.length === 0 &&
              <div className="git-clean"><Icon name="check-check" size={16} color="var(--running-400)" /> Working tree clean</div>}
          </div>

          <div className="commit-box">
            <textarea className="commit-msg" placeholder={`Commit message${staged.length ? ` (${staged.length} staged)` : ''}…`} rows={2} />
            <button className="commit-author-toggle" onClick={() => setShowAuthor(s => !s)}>
              <Icon name={showAuthor ? 'chevron-down' : 'chevron-right'} size={12} /> Author override
            </button>
            {showAuthor && (
              <div className="commit-author">
                <input className="commit-field" placeholder="Author name" defaultValue="Mara Reyes" />
                <input className="commit-field" placeholder="author@email.com" defaultValue="mara@dockyard.io" />
              </div>
            )}
            <Btn variant="primary" size="sm" icon="git-commit-horizontal" style={{ width: '100%', justifyContent: 'center' }}>
              Commit{staged.length ? ` ${staged.length} file${staged.length > 1 ? 's' : ''}` : ''}
            </Btn>
          </div>
        </div>

        {/* right: diff + history */}
        <div className="git-right">
          {selected ? (
            <div className="diff-pane">
              <div className="diff-head">
                <span className={`tree-change tc-${selected.change}`}>{selected.change}</span>
                <span className="mono diff-path">{selected.path}</span>
                <span className="diff-stat mono"><span className="add">+{selected.add}</span> <span className="del">−{selected.del}</span></span>
              </div>
              <div className="diff-body">
                {DIFF_SAMPLE.map((l, i) => (
                  <div key={i} className={`diff-line dl-${l.type}`}>
                    <span className="diff-gutter">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : l.type === 'hunk' ? '' : ' '}</span>
                    <span className="diff-text mono">{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="diff-pane diff-empty"><span className="mono">Select a changed file to view its diff</span></div>
          )}

          <div className="history-pane">
            <div className="history-head"><span className="eyebrow">History · {git.branch}</span></div>
            <div className="history-list">
              {git.commits.map(c => (
                <div className="commit-row" key={c.hash}>
                  <span className="commit-node" />
                  <div className="commit-info">
                    <div className="commit-msg-row">{c.msg}</div>
                    <div className="commit-meta mono">{c.hash} · {c.author} · {c.when}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChangeGroup({ title, count, files, selected, onSelect, action, onAction }) {
  if (files.length === 0) return null;
  return (
    <div className="change-group">
      <div className="change-group-head">
        <span className="change-group-title">{title}</span>
        <span className="change-group-count mono">{count}</span>
      </div>
      {files.map(f => (
        <div key={f.path} className={`change-row ${selected && selected.path === f.path ? 'on' : ''}`} onClick={() => onSelect(f)}>
          <span className={`tree-change tc-${f.change}`}>{f.change}</span>
          <span className="mono change-path">{f.path}</span>
          <button className="change-action" title={action} onClick={(e) => { e.stopPropagation(); onAction(f); }}>
            <Icon name={action === 'stage' ? 'plus' : 'minus'} size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { ProjectLogsTab, ProjectFilesTab, ProjectSourceTab });

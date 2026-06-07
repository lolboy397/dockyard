/* global React, Icon, Btn, Badge, Dot */
const { useState: usePjState } = React;

/* =========================================================================
   PROJECT STATUS — shared badge + animated dot
   idle/stopped (grey) · building (pulsing amber) · running (green glow) · failed (red)
   ========================================================================= */
const PROJ_STATUS = {
  idle:     { label: 'Stopped',  tone: 'idle' },
  building: { label: 'Building', tone: 'warn' },
  running:  { label: 'Running',  tone: 'running' },
  failed:   { label: 'Failed',   tone: 'danger' },
};

function ProjDot({ status, size = 8 }) {
  return <span className={`proj-dot proj-dot-${status}`} style={{ width: size, height: size }} />;
}

function ProjStatusBadge({ status }) {
  const s = PROJ_STATUS[status];
  return (
    <span className={`proj-badge proj-badge-${status}`}>
      <ProjDot status={status} size={7} />
      {s.label}
    </span>
  );
}

/* =========================================================================
   SAMPLE PROJECTS
   ========================================================================= */
const FILE_TREE_API = [
  { name: 'src', type: 'dir', open: true, children: [
    { name: 'index.ts', type: 'file', lang: 'ts', lines: 142 },
    { name: 'server.ts', type: 'file', lang: 'ts', lines: 88, change: 'M' },
    { name: 'routes', type: 'dir', open: true, children: [
      { name: 'jobs.ts', type: 'file', lang: 'ts', lines: 210, change: 'M' },
      { name: 'health.ts', type: 'file', lang: 'ts', lines: 24 },
    ]},
    { name: 'db', type: 'dir', children: [
      { name: 'pool.ts', type: 'file', lang: 'ts', lines: 56 },
      { name: 'migrations', type: 'dir', children: [
        { name: '0001_init.sql', type: 'file', lang: 'sql', lines: 64 },
        { name: '0002_jobs.sql', type: 'file', lang: 'sql', lines: 38, change: 'A' },
      ]},
    ]},
  ]},
  { name: 'Dockerfile', type: 'file', lang: 'docker', lines: 28, key: true },
  { name: 'package.json', type: 'file', lang: 'json', lines: 46, key: true },
  { name: 'tsconfig.json', type: 'file', lang: 'json', lines: 22 },
  { name: '.dockerignore', type: 'file', lang: 'text', lines: 8 },
  { name: 'README.md', type: 'file', lang: 'md', lines: 74 },
];

const FILE_TREE_WEB = [
  { name: 'app', type: 'dir', open: true, children: [
    { name: 'page.tsx', type: 'file', lang: 'tsx', lines: 96 },
    { name: 'layout.tsx', type: 'file', lang: 'tsx', lines: 44 },
    { name: 'globals.css', type: 'file', lang: 'css', lines: 180 },
  ]},
  { name: 'components', type: 'dir', children: [
    { name: 'Nav.tsx', type: 'file', lang: 'tsx', lines: 62 },
    { name: 'Hero.tsx', type: 'file', lang: 'tsx', lines: 88 },
  ]},
  { name: 'compose.yml', type: 'file', lang: 'yaml', lines: 34, key: true },
  { name: 'Dockerfile', type: 'file', lang: 'docker', lines: 22, key: true },
  { name: 'package.json', type: 'file', lang: 'json', lines: 52, key: true },
  { name: 'next.config.js', type: 'file', lang: 'js', lines: 18 },
];

const BUILD_LOG_API = [
  ['INFO', '#1 [internal] load build definition from Dockerfile'],
  ['INFO', '#2 [internal] load .dockerignore'],
  ['INFO', '#3 [1/6] FROM node:20-alpine@sha256:a1b2c3'],
  ['INFO', '#4 [2/6] WORKDIR /app'],
  ['INFO', '#5 [3/6] COPY package.json package-lock.json ./'],
  ['INFO', '#6 [4/6] RUN npm ci --omit=dev'],
  ['DIM',  '   added 214 packages in 9.2s'],
  ['INFO', '#7 [5/6] COPY . .'],
  ['INFO', '#8 [6/6] RUN npm run build'],
  ['DIM',  '   tsc -p tsconfig.json → dist/'],
  ['OK',   '#9 exporting to image'],
  ['OK',   '#10 naming to dockyard/jobs-api:latest'],
  ['OK',   'Build complete in 1m 04s · image 218 MB'],
];

const RUN_LOG_API = [
  ['14:32:08.142', 'INFO', 'listening on :3000'],
  ['14:32:08.319', 'INFO', 'connected to postgres-main'],
  ['14:32:11.402', 'INFO', 'GET /healthz 200 4ms'],
  ['14:32:14.811', 'WARN', 'slow query: SELECT * FROM jobs (412ms)'],
  ['14:32:18.221', 'INFO', 'GET /api/jobs?limit=50 200 124ms'],
  ['14:32:21.004', 'INFO', 'job 87a2 enqueued'],
];

const GIT_API = {
  branch: 'feature/job-retries',
  branches: ['main', 'feature/job-retries', 'fix/pool-leak'],
  remote: 'origin · github.com/dockyard/jobs-api',
  ahead: 2, behind: 0,
  staged: [
    { path: 'src/routes/jobs.ts', change: 'M', add: 38, del: 6 },
    { path: 'src/db/migrations/0002_jobs.sql', change: 'A', add: 38, del: 0 },
  ],
  unstaged: [
    { path: 'src/server.ts', change: 'M', add: 4, del: 2 },
    { path: 'README.md', change: 'M', add: 12, del: 0 },
  ],
  commits: [
    { hash: 'a31f9c2', msg: 'Add exponential backoff to job retries', author: 'Mara Reyes', when: '2h ago' },
    { hash: 'c8014ab', msg: 'Pool: release connections on error path', author: 'Kai Okafor', when: '5h ago' },
    { hash: 'e7d22ff', msg: 'Bump node base image to 20-alpine', author: 'Mara Reyes', when: '1d ago' },
    { hash: 'b4aeb68', msg: 'Initial jobs API scaffold', author: 'Mara Reyes', when: '3d ago' },
  ],
};

const DIFF_SAMPLE = [
  { type: 'hunk', text: '@@ -18,7 +18,11 @@ async function runJob(job: Job) {' },
  { type: 'ctx',  text: '   const ctx = await acquire();' },
  { type: 'ctx',  text: '   try {' },
  { type: 'del',  text: '-    await process(job);' },
  { type: 'add',  text: '+    await withRetry(() => process(job), {' },
  { type: 'add',  text: '+      attempts: 3,' },
  { type: 'add',  text: '+      backoff: exponential(200),' },
  { type: 'add',  text: '+    });' },
  { type: 'ctx',  text: '   } finally {' },
  { type: 'ctx',  text: '     ctx.release();' },
  { type: 'ctx',  text: '   }' },
];

const PROJECTS = [
  {
    id: 'jobs-api', name: 'jobs-api', description: 'Background job processing API · Node + Postgres',
    type: 'Dockerfile', status: 'running', built: true,
    image: 'dockyard/jobs-api:latest', size: '218 MB',
    ports: [{ host: 3000, container: 3000 }],
    branch: 'feature/job-retries', lastDeploy: '3m ago', cpu: '4.7%', mem: '186 MB',
    files: FILE_TREE_API, buildLog: BUILD_LOG_API, runLog: RUN_LOG_API, git: GIT_API,
  },
  {
    id: 'web-storefront', name: 'web-storefront', description: 'Next.js marketing + storefront',
    type: 'Compose', status: 'building', built: false,
    image: 'dockyard/web-storefront:latest', size: '—',
    ports: [{ host: 80, container: 3000 }, { host: 443, container: 3443 }],
    branch: 'main', lastDeploy: 'building…', cpu: '—', mem: '—',
    files: FILE_TREE_WEB, buildLog: BUILD_LOG_API, runLog: [], git: { ...GIT_API, branch: 'main', staged: [], unstaged: [] },
    buildProgress: 62, buildStep: '4 of 6',
  },
  {
    id: 'image-resizer', name: 'image-resizer', description: 'On-the-fly image transform service · Go',
    type: 'Dockerfile', status: 'failed', built: false,
    image: 'dockyard/image-resizer:latest', size: '—',
    ports: [{ host: 8080, container: 8080 }],
    branch: 'main', lastDeploy: 'failed 8m ago', cpu: '—', mem: '—',
    files: FILE_TREE_API, buildLog: BUILD_LOG_API, runLog: [], git: { ...GIT_API, branch: 'main', staged: [], unstaged: [] },
    portConflict: { host: 8080, by: 'metrics-otel' },
  },
  {
    id: 'docs-site', name: 'docs-site', description: 'Documentation site · static export',
    type: 'Dockerfile', status: 'idle', built: true,
    image: 'dockyard/docs-site:latest', size: '64 MB',
    ports: [{ host: 4000, container: 80 }],
    branch: 'main', lastDeploy: '2d ago', cpu: '—', mem: '—',
    files: FILE_TREE_WEB, buildLog: BUILD_LOG_API, runLog: [], git: { ...GIT_API, branch: 'main', staged: [], unstaged: [], ahead: 0 },
  },
  {
    id: 'analytics-worker', name: 'analytics-worker', description: 'Event rollup worker · Python',
    type: 'Compose', status: 'running', built: true,
    image: 'dockyard/analytics-worker:latest', size: '142 MB',
    ports: [],
    branch: 'main', lastDeploy: '6h ago', cpu: '0.6%', mem: '54 MB',
    files: FILE_TREE_API, buildLog: BUILD_LOG_API, runLog: RUN_LOG_API, git: { ...GIT_API, branch: 'main', staged: [], unstaged: [] },
  },
  {
    id: 'edge-proxy', name: 'edge-proxy', description: 'Caddy edge proxy + TLS',
    type: 'Compose', status: 'idle', built: false,
    image: '—', size: '—',
    ports: [{ host: 80, container: 80 }, { host: 443, container: 443 }],
    branch: 'main', lastDeploy: 'never', cpu: '—', mem: '—',
    files: FILE_TREE_WEB, buildLog: [], runLog: [], git: { ...GIT_API, branch: 'main', staged: [], unstaged: [], ahead: 0 },
  },
];

Object.assign(window, { PROJECTS, PROJ_STATUS, ProjDot, ProjStatusBadge,
  FILE_TREE_API, FILE_TREE_WEB, BUILD_LOG_API, RUN_LOG_API, GIT_API, DIFF_SAMPLE });

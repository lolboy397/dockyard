/* =========================================================================
   Volume Explorer — display metadata + API response types.

   The explorer browses a volume's *real* contents through the backend volume
   file-browser API (a helper container mounts the volume and the backend
   exec's ls/stat/cat/du/find inside it). This file only holds presentation
   helpers (icon/label per file kind, extension→kind inference) and the shapes
   of the API responses — there is no sample/mock filesystem.
   ========================================================================= */

/** Header summary passed in from the volumes list. */
export interface ExplorerVolume {
  name: string;
  driver: string;
  mount: string;
  size: string;
  used: string | null;
  created: string;
}

/** One directory entry as returned by GET /volumes/{name}/files (and /search). */
export interface VEntry {
  name: string;
  type: 'dir' | 'file';
  size: number;     // bytes (0 for dirs)
  modified: number; // unix seconds
  path?: string;    // volume-root-relative path (search results only)
}

/** Inline preview payload from GET /volumes/{name}/file. */
export interface VFilePreview {
  binary: boolean;
  truncated: boolean;
  size: number;
  content: string;
}

/** Usage/overview payload from GET /volumes/{name}/usage. */
export interface VUsage {
  size_bytes: number;
  files: number;
  dirs: number;
  breakdown: { name: string; size_bytes: number }[];
  mounts: { container: string; path: string; mode: string }[];
}

/** One point-in-time volume backup (GET/POST /volumes/{name}/backups). */
export interface VolumeBackup {
  id: number;
  volume_name: string;
  file: string;
  size_bytes: number;
  consistent: boolean; // container was stopped during the backup
  note: string;
  created_at: string;
}

/** Opt-in automatic-backup policy (GET/PUT /volumes/{name}/backup-schedule). */
export interface BackupSchedule {
  volume_name: string;
  enabled: boolean;
  interval_hours: number;
  keep: number;
  stop_container: boolean;
  last_run_at: string | null;
  updated_at: string;
}

/** Icon + human label per file "kind". */
export const KIND: Record<string, { icon: string; label: string }> = {
  config: { icon: 'sliders-horizontal', label: 'Config' },
  text:   { icon: 'file-text',          label: 'Text' },
  log:    { icon: 'scroll-text',        label: 'Log' },
  json:   { icon: 'braces',             label: 'JSON' },
  csv:    { icon: 'table-2',            label: 'CSV' },
  code:   { icon: 'file-code-2',        label: 'Code' },
  md:     { icon: 'file-text',          label: 'Markdown' },
  image:  { icon: 'image',              label: 'Image' },
  pdf:    { icon: 'file-text',          label: 'PDF' },
  archive:{ icon: 'file-archive',       label: 'Archive' },
  data:   { icon: 'file',               label: 'Data' },
  binary: { icon: 'file',               label: 'Binary' },
  cert:   { icon: 'shield',             label: 'Certificate' },
};

/** Kinds whose contents can be shown inline as text. */
export const TEXT_KINDS = new Set(['config', 'text', 'log', 'json', 'csv', 'code', 'md']);

/** Extension → kind lookup driving the per-file icon/label. */
const EXT_KIND: Record<string, string> = {
  conf: 'config', cnf: 'config', ini: 'config', cfg: 'config', toml: 'config',
  yaml: 'config', yml: 'config', env: 'config', properties: 'config',
  txt: 'text', text: 'text',
  log: 'log',
  json: 'json',
  csv: 'csv', tsv: 'csv',
  js: 'code', ts: 'code', go: 'code', py: 'code', rb: 'code', sh: 'code',
  c: 'code', h: 'code', cpp: 'code', cc: 'code', java: 'code', rs: 'code',
  php: 'code', sql: 'code', html: 'code', css: 'code', scss: 'code', xml: 'code',
  md: 'md', markdown: 'md',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image',
  webp: 'image', bmp: 'image', ico: 'image',
  pdf: 'pdf',
  gz: 'archive', tar: 'archive', tgz: 'archive', zip: 'archive', bz2: 'archive',
  xz: 'archive', '7z': 'archive', rar: 'archive',
  crt: 'cert', pem: 'cert', cer: 'cert', cert: 'cert', key: 'cert',
};

/** A handful of extension-less filenames that are conventionally text. */
const NAME_KIND: Record<string, string> = {
  readme: 'md', license: 'text', changelog: 'md', dockerfile: 'code',
  makefile: 'code', '.gitignore': 'config', '.dockerignore': 'config',
  '.env': 'config',
};

/** Infer a file "kind" from its name (extension first, then known names). */
export function kindForName(name: string): string {
  const lower = name.toLowerCase();
  if (NAME_KIND[lower]) return NAME_KIND[lower];
  const dot = lower.lastIndexOf('.');
  if (dot > 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1);
    if (EXT_KIND[ext]) return EXT_KIND[ext];
  }
  return 'binary';
}

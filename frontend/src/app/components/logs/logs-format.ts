// Pure, framework-free helpers for the Logs page: ANSI colour parsing, stack-trace
// continuation detection, and relative-time formatting. Kept out of the component
// so they're unit-testable in isolation (see logs-format.spec.ts).

/** A run of message text carrying its ANSI colour class (cls=''=default fg). */
export interface AnsiRun { t: string; cls: string; }

// Conservative stack-trace continuation markers (non-indented; indented lines are
// folded by the leading-whitespace test). Java `at …` / `Caused by:` / `… N more`,
// Python `File "…", line`. Exception-type lines are excluded — too easily confused
// with ordinary "SomeError: …" log lines.
const CONT_RE = /^(at\s|Caused by:|\.{3}\s*\d+\s+more\b|File ".+", line\s)/;

/** Maps an SGR parameter list to a foreground colour class, given the current one.
 *  Reset (0 / empty) clears; 39 restores default; 30-37 and 90-97 set a colour.
 *  Bold / background / styles are intentionally ignored. */
export function sgrToClass(params: string, current: string): string {
  const codes = params.split(';').filter(x => x !== '').map(Number);
  if (!codes.length || codes.includes(0)) return '';
  let cls = current;
  for (const n of codes) {
    if (n === 39) cls = '';
    else if (n >= 30 && n <= 37) cls = 'ansi-' + (n - 30);
    else if (n >= 90 && n <= 97) cls = 'ansi-b' + (n - 90);
  }
  return cls;
}

/** Parses a raw log line into ANSI colour runs, dropping non-colour control
 *  sequences (cursor moves, clears) and CR. SGR foreground colours map to
 *  `.ansi-*` classes; everything else renders in the default colour. Trailing
 *  whitespace (and whitespace-only trailing runs) is trimmed so it doesn't widen
 *  virtualised rows. Concatenating the run texts yields the plain message. */
export function parseAnsi(raw: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  let cls = '';
  let buf = '';
  const push = () => { if (buf) { runs.push({ t: buf, cls }); buf = ''; } };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\x1B' && raw[i + 1] === '[') {
      let j = i + 2;
      while (j < raw.length && !/[A-Za-z]/.test(raw[j])) j++;
      if (raw[j] === 'm') { push(); cls = sgrToClass(raw.slice(i + 2, j), cls); }
      i = j; // skip the whole CSI sequence (non-'m' ones are simply dropped)
      continue;
    }
    if (c === '\r') continue;
    buf += c;
  }
  push();
  while (runs.length && !runs[runs.length - 1].t.trim()) runs.pop();
  if (runs.length) runs[runs.length - 1].t = runs[runs.length - 1].t.replace(/\s+$/, '');
  return runs;
}

/** Heuristic: is this line a continuation of a multi-line entry (stack trace,
 *  wrapped exception)? Indented lines and common Java/Python/Node trace markers
 *  fold under the preceding primary line. Deliberately conservative. */
export function isContinuationLine(text: string): boolean {
  if (!text) return false;
  if (/^\s/.test(text)) return true; // any indented line
  return CONT_RE.test(text);
}

// Structured (JSON-lines) log handling. Go/Node services commonly emit one JSON
// object per line; rendered raw they're an unreadable blob, and the level is
// guessed by regex over the whole line (so a "panic" substring mistags an info
// line). We parse it, take the real level + message, and render the message
// followed by a dimmed key=value tail — readable, single-line, fully searchable.
const JSON_LEVEL_FIELDS = ['level', 'lvl', 'severity', 'levelname', 'loglevel'];
const JSON_MSG_FIELDS = ['message', 'msg', 'log'];
const JSON_SKIP = new Set([...JSON_LEVEL_FIELDS, ...JSON_MSG_FIELDS, 'time', 'ts', 'timestamp', 't', '@timestamp']);
const LEVEL_MAP: Record<string, 'info' | 'warn' | 'err'> = {
  trace: 'info', debug: 'info', info: 'info', information: 'info', notice: 'info',
  warn: 'warn', warning: 'warn',
  error: 'err', err: 'err', fatal: 'err', panic: 'err', dpanic: 'err',
  critical: 'err', crit: 'err', emergency: 'err', emerg: 'err', alert: 'err',
};

/** Parses a JSON-lines log entry into a readable render (message + dimmed
 *  key=value tail) and its real level. Returns null when the line isn't a JSON
 *  object or yields nothing useful, so the caller falls back to raw rendering. */
export function parseStructured(line: string): { level?: 'info' | 'warn' | 'err'; runs: AnsiRun[]; text: string } | null {
  const s = line.trimStart();
  if (s[0] !== '{') return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch { return null; }

  let level: 'info' | 'warn' | 'err' | undefined;
  for (const f of JSON_LEVEL_FIELDS) {
    const v = obj[f];
    if (typeof v === 'string') { level = LEVEL_MAP[v.toLowerCase()]; break; }
  }
  let message = '';
  for (const f of JSON_MSG_FIELDS) {
    const v = obj[f];
    if (typeof v === 'string') { message = v; break; }
  }

  const runs: AnsiRun[] = [];
  let text = '';
  if (message) { runs.push({ t: message, cls: '' }); text += message; }
  for (const k of Object.keys(obj)) {
    if (JSON_SKIP.has(k.toLowerCase())) continue;
    const v = obj[k];
    const vs = typeof v === 'string' ? v : JSON.stringify(v);
    const part = `${runs.length ? '  ' : ''}${k}=${vs}`;
    runs.push({ t: part, cls: 'ldim' });
    text += part;
  }
  if (!runs.length) return null;
  return { level, runs, text };
}

/** Relative age ("now", "12s", "5m", "2h", "3d") of an RFC3339 timestamp, or the
 *  given fallback when it's absent / unparseable. `now` is epoch-ms, injected so
 *  the function stays pure and testable. */
export function formatRelative(rawTs: string, fallback: string, now: number): string {
  if (!rawTs) return fallback;
  const t = new Date(rawTs).getTime();
  if (isNaN(t)) return fallback;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 1) return 'now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

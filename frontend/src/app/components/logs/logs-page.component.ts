import {
  Component, OnInit, OnDestroy, ViewChild, ElementRef,
  ChangeDetectionStrategy, signal, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { Subscription } from 'rxjs';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';
import { DockerService } from '../../services/docker.service';
import { WebSocketService, MultiLogStream, MultiLogFrame, MultiLogState } from '../../services/websocket.service';
import { AuthService } from '../../auth/auth.service';
import { AnsiRun, parseAnsi, isContinuationLine, formatRelative, parseStructured } from './logs-format';
import { ContainerSummary } from '../../models/docker.models';

/** One log source = one container's row in the sidebar. */
interface LogSource {
  id: string;
  name: string;
  color: string;
  on: boolean;
}

type LineKind = 'log' | 'error' | 'status';
type Level = 'info' | 'warn' | 'err';

interface LogLine {
  /** Stable, monotonic id — the trackBy key so rows are reused, not rebuilt. */
  uid: number;
  srcId: string;
  src: string;
  color: string;
  /** Display clock (HH:MM:SS) derived from the real Docker timestamp. */
  ts: string;
  /** Raw Docker RFC3339 timestamp — used for dedup + downloads. */
  rawTs: string;
  level: Level;
  levelLabel: string;
  levelClass: string;
  /** Plain text (ANSI stripped) — the basis for search, level, dedup, export. */
  msg: string;
  /** ANSI-parsed colour runs; concatenating run text yields `msg`. */
  runs: AnsiRun[];
  /** Stable no-search render segments, computed once — returned by reference from
   *  segs() when no filter is active, so CD doesn't reallocate per row per frame. */
  defaultSegs: Seg[];
  kind: LineKind;
  /** uid of the line this one is grouped under (its own uid when it's a primary). */
  groupId: number;
  /** True when this is a folded continuation (stack-trace / indented) line. */
  isContinuation: boolean;
}

/** A render segment: text + whether it's a search hit + its ANSI colour class. */
interface Seg { t: string; m: boolean; cls: string; }

// A 12-colour palette (was 8) spaced around the hue wheel so neighbouring
// sources stay distinguishable; container names remain the primary label, so
// colour is a secondary cue rather than the only one.
const SOURCE_COLORS = [
  '#22D3EE', '#34D399', '#60A5FA', '#FBBF24',
  '#A78BFA', '#F472B6', '#FB923C', '#4ADE80',
  '#E879F9', '#2DD4BF', '#F87171', '#818CF8',
];

const MAX_LINES = 2000;
const PREFS_KEY = 'dy_logs_prefs';

const WARN_RE = /\b(WARN|WARNING)\b/i;
const ERR_RE = /\b(ERROR|ERR|FATAL|CRIT|PANIC|EMERG|ALERT)\b/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

@Component({
  selector: 'app-logs-page',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, IconComponent, StatusDotComponent],
  templateUrl: './logs-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsPageComponent implements OnInit, OnDestroy {
  /** Virtual-scroll row height — must match the fixed .lline height in styles. */
  readonly itemSize = 19;

  // The nowrap path virtualises (fixed-height rows); the wrap path renders plain
  // because wrapped lines have variable height a fixed itemSize can't represent.
  @ViewChild('vp') viewport?: CdkVirtualScrollViewport;
  @ViewChild('plain') plain?: ElementRef<HTMLDivElement>;

  // ── Reactive state (signals → OnPush, no zone-wide CD on every frame) ───────
  readonly sources = signal<LogSource[]>([]);
  readonly lines = signal<LogLine[]>([]);
  /** Per-source cumulative line count, kept out of `sources` so count churn
   *  doesn't re-render source identity. */
  readonly counts = signal<Record<string, number>>({});
  /** Per-container level tallies from the server — drives the level pills, since
   *  server-side filtering means the client no longer receives every line. */
  readonly serverCounts = signal<Map<string, { info: number; warn: number; err: number }>>(new Map());

  readonly paused = signal(false);
  readonly wrap = signal(false);
  readonly filterText = signal('');
  readonly useRegex = signal(false);
  readonly level = signal<'all' | Level>('all');
  readonly tail = signal('50');
  readonly lps = signal(0);
  readonly atBottom = signal(true);
  /** Real socket connection state, so the "live" indicator is honest during a
   *  reconnect/offline rather than showing a confident green dot while frozen. */
  readonly connState = signal<MultiLogState>('connecting');
  /** Read-only viewers can't read log content (it may carry secrets); the page
   *  shows an access-required panel instead of opening the stream. The backend is
   *  the real enforcer — every log endpoint is operator+ — this is just UX. */
  readonly denied = signal(false);
  /** Show timestamps as relative age ("12s") instead of an absolute clock. */
  readonly relTime = signal(false);
  /** Bumped ~1/s while relTime is on so visible relative stamps re-render. */
  readonly nowTick = signal(0);
  /** Mobile only: whether the sources drawer is slid open. */
  readonly sideOpen = signal(false);
  /** group ids (primary uid) whose continuation lines are folded away. */
  readonly collapsed = signal<Set<number>>(new Set());

  readonly levels: { v: 'all' | Level; label: string }[] = [
    { v: 'all', label: 'All' },
    { v: 'info', label: 'Info' },
    { v: 'warn', label: 'Warn' },
    { v: 'err', label: 'Error' },
  ];
  readonly tails = ['50', '100', '500', '1000'];

  readonly activeSources = computed(() => this.sources().filter(s => s.on));
  private readonly activeIds = computed(() => new Set(this.activeSources().map(s => s.id)));

  /** Compiled search: substring (lower) or a RegExp; invalid regex falls back to substring. */
  readonly compiledFilter = computed(() => {
    const t = this.filterText().trim();
    if (!t) return { text: '', lower: '', re: undefined as RegExp | undefined, invalid: false };
    const lower = t.toLowerCase();
    if (!this.useRegex()) return { text: t, lower, re: undefined as RegExp | undefined, invalid: false };
    try { return { text: t, lower, re: new RegExp(t, 'i'), invalid: false }; }
    catch { return { text: t, lower, re: undefined as RegExp | undefined, invalid: true }; }
  });
  readonly filterInvalid = computed(() => this.compiledFilter().invalid);

  /** The view, recomputed ONLY when lines / sources / level / filter change. */
  readonly filteredLines = computed<LogLine[]>(() => {
    const all = this.lines();
    const active = this.activeIds();
    const lvl = this.level();
    const f = this.compiledFilter();
    let res = all.filter(l => l.kind === 'status' || active.has(l.srcId));
    if (lvl !== 'all') res = res.filter(l => l.kind !== 'log' || l.level === lvl);
    if (f.text) {
      if (f.re) { const re = f.re; res = res.filter(l => re.test(l.msg) || re.test(l.src)); }
      else { const n = f.lower; res = res.filter(l => l.msg.toLowerCase().includes(n) || l.src.toLowerCase().includes(n)); }
    } else {
      // Fold collapsed groups — but only when NOT searching, so a search always
      // surfaces matching lines regardless of which trace they're folded into.
      const col = this.collapsed();
      if (col.size) res = res.filter(l => !l.isContinuation || !col.has(l.groupId));
    }
    return res;
  });

  /** primary uid → count of folded continuation lines under it (drives the
   *  collapse chevron + the "+N" badge on the primary row). */
  readonly groupSizes = computed(() => {
    const m: Record<number, number> = {};
    for (const l of this.lines()) if (l.isContinuation) m[l.groupId] = (m[l.groupId] ?? 0) + 1;
    return m;
  });

  /** Level tallies over the active (source-filtered) lines, ignoring the level
   *  pill itself — so the counts don't collapse to 0 once a level is selected. */
  readonly levelCounts = computed(() => {
    const active = this.activeIds();
    const sc = this.serverCounts();
    const c: Record<string, number> = { all: 0, info: 0, warn: 0, err: 0 };
    // Sum the server's per-container tallies over the active sources. These stay
    // accurate even when a level filter means we don't receive the other levels.
    for (const id of active) {
      const t = sc.get(id);
      if (!t) continue;
      c['info'] += t.info; c['warn'] += t.warn; c['err'] += t.err;
    }
    c['all'] = c['info'] + c['warn'] + c['err'];
    return c;
  });

  // ── Internals ───────────────────────────────────────────────────────────────
  private stream?: MultiLogStream;
  private framesSub?: Subscription;
  private stateSub?: Subscription;
  private lpsInterval?: ReturnType<typeof setInterval>;
  /** Fast id→source lookup, kept in step with the `sources` signal. */
  private sourceById = new Map<string, LogSource>();
  /** Per-source current group id, so continuation lines fold under their primary. */
  private lastBySrc = new Map<string, number>();

  private pending: LogLine[] = [];
  private pausedBuf: LogLine[] = [];
  private countDelta: Record<string, number> = {};
  private flushScheduled = false;
  private uidSeq = 1;
  private lpsCounter = 0;
  private firstLoad = true;
  private savedOnIds: Set<string> | null = null;
  private scrollQueued = false;
  /** Recently-seen (srcId|ts|msg) keys to drop reconnect-overlap duplicates. */
  private seen = new Set<string>();
  /** Per-line highlight segments, cached by (line, pattern) so they're computed once. */
  private segCache = new WeakMap<LogLine, { key: string; segs: Seg[] }>();

  constructor(private docker: DockerService, private ws: WebSocketService, private route: ActivatedRoute, private auth: AuthService) {}

  ngOnInit(): void {
    // Log content is operator+ on the backend; a viewer who deep-links here would
    // otherwise watch a stream that 403s and never produces output. Short-circuit
    // to a clear access panel instead.
    if (!this.auth.canWrite()) {
      this.denied.set(true);
      return;
    }
    this.restorePrefs();
    // First-time visitors on a phone default to wrap — nowrap requires horizontal
    // panning of every line, which is unusable on a narrow screen.
    if (!this.wrapPrefSaved && typeof matchMedia !== 'undefined' && matchMedia('(max-width: 820px)').matches) {
      this.wrap.set(true);
    }
    // Deep-link: ?search= pre-fills the filter; ?since= time-anchors the first
    // fetch — used by the Insights "view logs at this time" correlation pivot.
    const qp = this.route.snapshot.queryParamMap;
    const search = qp.get('search');
    if (search) this.filterText.set(search);
    this.initialSince = qp.get('since') || undefined;
    this.stream = this.ws.streamMultiLogs();
    this.framesSub = this.stream.frames$.subscribe(frame => this.ingest(frame));
    this.stateSub = this.stream.state$.subscribe(s => this.connState.set(s));
    this.stream.setLevel(this.level()); // apply any restored level filter server-side
    this.loadContainers();
    this.lpsInterval = setInterval(() => {
      this.lps.set(this.lpsCounter);
      this.lpsCounter = 0;
      if (this.relTime()) this.nowTick.update(n => n + 1); // re-render relative stamps
    }, 1000);
  }

  ngOnDestroy(): void {
    this.framesSub?.unsubscribe();
    this.stateSub?.unsubscribe();
    this.stream?.close();
    if (this.lpsInterval) clearInterval(this.lpsInterval);
  }

  // ── Ingestion (batched via rAF; signals updated once per frame, not per line) ─
  private ingest(frame: MultiLogFrame): void {
    if (frame.type === 'counts') {
      if (frame.id && frame.counts) {
        const id = frame.id, c = frame.counts;
        this.serverCounts.update(m => { const n = new Map(m); n.set(id, c); return n; });
      }
      return;
    }
    if (frame.type === 'status') {
      this.enqueue(this.makeLine('__system__', 'system', 'var(--fg-muted)', '', frame.data ?? '', 'status'));
      return;
    }
    const id = frame.id;
    if (!id) return;
    const src = this.sourceById.get(id);
    if (!src || !src.on) return; // unknown or toggled-off source — drop in-flight frame

    let rawTs = frame.ts ?? '';
    let data = frame.data ?? '';
    if (!rawTs) {
      // Back-compat: an older backend left Docker's timestamp inside the line.
      const sp = data.indexOf(' ');
      if (sp > 0 && ISO_RE.test(data.slice(0, sp))) { rawTs = data.slice(0, sp); data = data.slice(sp + 1); }
    }
    this.enqueue(this.makeLine(id, src.name, src.color, rawTs, data, frame.type === 'error' ? 'error' : 'log'));
  }

  private makeLine(srcId: string, src: string, color: string, rawTs: string, raw: string, kind: LineKind): LogLine {
    const runs = parseAnsi(raw);
    const clean = runs.map(r => r.t).join('');
    // Structured (JSON) line: take its real level + a readable render (message +
    // dimmed key=value tail) instead of guessing the level over the raw blob.
    const structured = kind === 'log' ? parseStructured(clean) : null;
    const level: Level = kind === 'error' ? 'err'
      : structured ? (structured.level ?? 'info')
      : WARN_RE.test(clean) ? 'warn'
      : ERR_RE.test(clean) ? 'err'
      : 'info';
    const displayRuns = structured ? structured.runs : runs;
    const displayMsg = structured ? structured.text : clean;

    const uid = this.uidSeq++;
    // Group continuation lines (indented / stack-trace markers) under the most
    // recent primary line from the same source. Errors/status notices break any
    // open group. Only real container output ('log') participates.
    let groupId = uid;
    let isContinuation = false;
    if (kind === 'log') {
      const prevGroup = this.lastBySrc.get(srcId);
      if (prevGroup !== undefined && isContinuationLine(clean)) {
        groupId = prevGroup;
        isContinuation = true;
      }
      this.lastBySrc.set(srcId, groupId);
    } else {
      this.lastBySrc.delete(srcId);
    }

    return {
      uid,
      srcId, src, color, rawTs,
      ts: this.formatTs(rawTs),
      level,
      levelLabel: level.toUpperCase(),
      levelClass: 'lvl-' + level,
      msg: displayMsg,
      runs: displayRuns,
      defaultSegs: displayRuns.length ? displayRuns.map(r => ({ t: r.t, m: false, cls: r.cls })) : [{ t: '', m: false, cls: '' }],
      kind,
      groupId,
      isContinuation,
    };
  }

  private formatTs(rawTs: string): string {
    const d = rawTs ? new Date(rawTs) : new Date();
    const dt = isNaN(d.getTime()) ? new Date() : d;
    return dt.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private enqueue(line: LogLine): void {
    if (line.kind !== 'status') this.countDelta[line.srcId] = (this.countDelta[line.srcId] ?? 0) + 1;
    this.lpsCounter++;
    // Pause HOLDS lines (in a capped buffer) instead of dropping them; status
    // notices always go live.
    if (this.paused() && line.kind !== 'status') {
      this.pausedBuf.push(line);
      if (this.pausedBuf.length > MAX_LINES) this.pausedBuf.splice(0, this.pausedBuf.length - MAX_LINES);
    } else {
      this.pending.push(line);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;

    if (Object.keys(this.countDelta).length) {
      const delta = this.countDelta; this.countDelta = {};
      this.counts.update(c => {
        const n = { ...c };
        for (const k in delta) n[k] = (n[k] ?? 0) + delta[k];
        return n;
      });
    }

    if (!this.pending.length) return;
    const batch = this.pending; this.pending = [];

    const add: LogLine[] = [];
    for (const l of batch) {
      if (l.kind === 'log' && l.rawTs) {
        const key = l.srcId + '|' + l.rawTs + '|' + l.msg;
        if (this.seen.has(key)) continue; // reconnect-overlap duplicate
        this.seen.add(key);
      }
      add.push(l);
    }
    if (!add.length) return;

    this.lines.update(cur => {
      let next = cur.length ? cur.concat(add) : add;
      if (next.length > MAX_LINES) next = next.slice(next.length - MAX_LINES);
      return next;
    });
    if (this.seen.size > MAX_LINES * 2) {
      this.seen = new Set(
        this.lines().filter(l => l.kind === 'log' && l.rawTs).map(l => l.srcId + '|' + l.rawTs + '|' + l.msg),
      );
    }
    this.stickToBottom();
  }

  // ── Auto-scroll (only when parked at the bottom) ────────────────────────────
  /** The element that actually scrolls, whichever render path is active. */
  private activeScrollEl(): HTMLElement | undefined {
    return this.wrap() ? this.plain?.nativeElement : this.viewport?.elementRef.nativeElement;
  }

  private scrollBottom(): void {
    if (this.wrap()) {
      const el = this.plain?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      this.viewport?.scrollTo({ bottom: 0, behavior: 'auto' }); // instant: reduced-motion safe
    }
  }

  /** Bound to (scroll) on both scroll containers — keeps `atBottom` in sync so we
   *  never yank the operator down while they're reading history. */
  onScroll(): void {
    const el = this.activeScrollEl();
    if (!el) return;
    const ab = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    if (ab !== this.atBottom()) this.atBottom.set(ab);
  }

  private stickToBottom(): void {
    if (!this.atBottom() || this.scrollQueued) return;
    this.scrollQueued = true;
    setTimeout(() => { this.scrollQueued = false; this.scrollBottom(); }, 0);
  }

  jumpToBottom(): void {
    this.atBottom.set(true);
    this.scrollBottom();
  }

  // ── Search highlight ────────────────────────────────────────────────────────
  segs(line: LogLine): Seg[] {
    // Non-log lines (stream errors / status notices) render as one plain segment.
    if (line.kind !== 'log') return [{ t: line.msg, m: false, cls: '' }];
    const f = this.compiledFilter();
    // No active search: the stable, precomputed colour-run segments (same array
    // reference each call, so OnPush CD doesn't churn the row).
    if (!f.text) return line.defaultSegs;
    const key = (f.re ? 're:' : 'tx:') + (f.re ? f.re.source : f.lower);
    const cached = this.segCache.get(line);
    if (cached && cached.key === key) return cached.segs;
    const segs = this.computeSegs(line.runs, f);
    this.segCache.set(line, { key, segs });
    return segs;
  }

  /** Splits each ANSI run by search matches, keeping the run's colour class — so
   *  colour and highlight compose instead of clobbering each other. */
  private computeSegs(runs: AnsiRun[], f: { re?: RegExp; lower: string }): Seg[] {
    const out: Seg[] = [];
    for (const r of runs) {
      for (const s of this.matchSegs(r.t, f)) out.push({ t: s.t, m: s.m, cls: r.cls });
    }
    return out.length ? out : [{ t: '', m: false, cls: '' }];
  }

  /** Splits one string into matched / unmatched runs for the active filter. */
  private matchSegs(msg: string, f: { re?: RegExp; lower: string }): { t: string; m: boolean }[] {
    const out: { t: string; m: boolean }[] = [];
    if (f.re) {
      const re = new RegExp(f.re.source, 'gi');
      let last = 0;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(msg)) && guard++ < 1000) {
        if (m.index > last) out.push({ t: msg.slice(last, m.index), m: false });
        const hit = m[0] || '';
        out.push({ t: hit, m: true });
        last = m.index + hit.length;
        if (!hit) re.lastIndex++; // avoid a zero-length-match infinite loop
      }
      if (last < msg.length) out.push({ t: msg.slice(last), m: false });
    } else {
      const lower = msg.toLowerCase();
      const needle = f.lower;
      let last = 0;
      let i = needle ? lower.indexOf(needle) : -1;
      while (i !== -1) {
        if (i > last) out.push({ t: msg.slice(last, i), m: false });
        out.push({ t: msg.slice(i, i + needle.length), m: true });
        last = i + needle.length;
        i = lower.indexOf(needle, last);
      }
      if (last < msg.length) out.push({ t: msg.slice(last), m: false });
    }
    return out.length ? out : [{ t: msg, m: false }];
  }

  // ── Source list ─────────────────────────────────────────────────────────────
  loadContainers(): void {
    this.docker.listContainers(true).subscribe(containers => {
      const prevIds = new Set(this.sourceById.keys());
      const nextIds = new Set(containers.map(c => c.Id));
      for (const id of prevIds) if (!nextIds.has(id)) this.stream?.unsubscribe(id);

      const deep = this.firstLoad ? this.deepLinkSet(containers) : null;

      const next: LogSource[] = containers.map((c, i) => {
        const prev = this.sourceById.get(c.Id);
        let on: boolean;
        if (prev) on = prev.on;
        else if (deep) on = deep.has(c.Id);
        else if (this.savedOnIds) on = this.savedOnIds.has(c.Id);
        else on = c.State === 'running';
        return {
          id: c.Id,
          name: c.Names[0]?.replace('/', '') ?? c.Id.slice(0, 8),
          color: SOURCE_COLORS[i % SOURCE_COLORS.length],
          on,
        };
      });
      this.setSources(next);
      this.firstLoad = false;

      // Subscribe the active ones (duplicate subscribes are ignored server-side).
      // Time-anchor the very FIRST subscribe when deep-linked from an error (a
      // larger tail gives context around that moment); used once, then cleared.
      const since = this.initialSince;
      this.initialSince = undefined;
      next.filter(s => s.on).forEach(s => this.stream?.subscribe(s.id, since ? '500' : this.tail(), since));
    });
  }

  private setSources(next: LogSource[]): void {
    this.sources.set(next);
    this.sourceById = new Map(next.map(s => [s.id, s]));
  }

  toggleSource(s: LogSource): void {
    const on = !s.on;
    this.setSources(this.sources().map(x => (x.id === s.id ? { ...x, on } : x)));
    if (on) this.stream?.subscribe(s.id, this.tail());
    else this.stream?.unsubscribe(s.id);
    this.savePrefs();
  }

  setAll(on: boolean): void {
    const cur = this.sources();
    const changed = cur.filter(s => s.on !== on);
    this.setSources(cur.map(s => ({ ...s, on })));
    changed.forEach(s => (on ? this.stream?.subscribe(s.id, this.tail()) : this.stream?.unsubscribe(s.id)));
    this.savePrefs();
  }

  /** Solo: show only this source, mute the rest (one click vs None-then-pick). */
  isolate(s: LogSource, ev?: Event): void {
    ev?.stopPropagation();
    ev?.preventDefault();
    const cur = this.sources();
    this.setSources(cur.map(x => ({ ...x, on: x.id === s.id })));
    cur.forEach(x => {
      if (x.id === s.id) this.stream?.subscribe(x.id, this.tail());
      else if (x.on) this.stream?.unsubscribe(x.id);
    });
    this.savePrefs();
  }

  setTail(t: string): void {
    if (t === this.tail()) return;
    this.tail.set(t);
    // Changing history depth reloads the view: clear so the fresh tail replays in
    // order (and dedup state with it), then re-follow the active sources.
    this.lines.set([]);
    this.seen.clear();
    this.lastBySrc.clear();
    this.collapsed.set(new Set());
    this.serverCounts.set(new Map());
    this.segCache = new WeakMap<LogLine, { key: string; segs: Seg[] }>();
    this.activeSources().forEach(s => {
      this.stream?.unsubscribe(s.id);
      this.stream?.subscribe(s.id, t);
    });
    this.savePrefs();
  }

  count(id: string): number { return this.counts()[id] ?? 0; }

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  setLevel(v: 'all' | Level): void {
    this.level.set(v);
    this.stream?.setLevel(v); // drop non-matching lines server-side (counts still flow)
    this.savePrefs();
  }

  toggleWrap(): void {
    this.wrap.set(!this.wrap());
    this.savePrefs();
    // The active scroll element just swapped; restore the bottom-stick if we were there.
    if (this.atBottom()) setTimeout(() => this.scrollBottom(), 0);
  }

  toggleRegex(): void { this.useRegex.set(!this.useRegex()); }

  toggleRel(): void { this.relTime.set(!this.relTime()); this.nowTick.update(n => n + 1); this.savePrefs(); }

  /** Relative age of a line ("now", "12s", "5m", "2h", "3d"); falls back to the
   *  absolute clock when there's no real timestamp. Reads nowTick so it ticks. */
  rel(line: LogLine): string {
    this.nowTick(); // dependency so relative stamps re-render on tick
    return formatRelative(line.rawTs, line.ts, Date.now());
  }

  toggleSide(): void { this.sideOpen.set(!this.sideOpen()); }
  closeSide(): void { if (this.sideOpen()) this.sideOpen.set(false); }

  /** Fold / unfold the continuation lines grouped under a primary line. */
  toggleGroup(uid: number, ev?: Event): void {
    ev?.stopPropagation();
    const next = new Set(this.collapsed());
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    this.collapsed.set(next);
  }

  togglePause(): void {
    const next = !this.paused();
    this.paused.set(next);
    if (!next && this.pausedBuf.length) {
      // Resume: flush everything captured while paused (nothing was dropped).
      this.pending.push(...this.pausedBuf);
      this.pausedBuf = [];
      this.scheduleFlush();
    }
  }

  clearLines(): void {
    this.lines.set([]);
    this.counts.set({});
    this.seen.clear();
    this.pending = [];
    this.pausedBuf = [];
    this.countDelta = {};
    this.lastBySrc.clear();
    this.collapsed.set(new Set());
    this.serverCounts.set(new Map());
    this.segCache = new WeakMap<LogLine, { key: string; segs: Seg[] }>();
  }

  trackByUid = (_: number, l: LogLine) => l.uid;

  private exportText(): string {
    return this.filteredLines()
      .map(l => `${l.rawTs || l.ts}  ${l.level.toUpperCase().padEnd(5)} ${l.src}  ${l.msg}`)
      .join('\n');
  }

  download(): void {
    const blob = new Blob([this.exportText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dockyard-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  copyVisible(): void {
    try { navigator.clipboard?.writeText(this.exportText()); } catch { /* clipboard unavailable */ }
  }

  // ── Preferences (sessionStorage) + deep-link ────────────────────────────────
  private savePrefs(): void {
    try {
      sessionStorage.setItem(PREFS_KEY, JSON.stringify({
        onIds: this.activeSources().map(s => s.id),
        tail: this.tail(),
        wrap: this.wrap(),
        level: this.level(),
        relTime: this.relTime(),
      }));
    } catch { /* storage unavailable */ }
  }

  /** True once an explicit wrap preference is restored, so the mobile default
   *  doesn't override a deliberate choice. */
  private wrapPrefSaved = false;
  /** RFC3339 time-anchor from a ?since= deep-link, applied to the first subscribe
   *  only (e.g. pivoting from an Insights error to the logs at that moment). */
  private initialSince?: string;

  private restorePrefs(): void {
    try {
      const raw = sessionStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.tail === 'string') this.tail.set(p.tail);
      if (typeof p.wrap === 'boolean') { this.wrap.set(p.wrap); this.wrapPrefSaved = true; }
      if (typeof p.relTime === 'boolean') this.relTime.set(p.relTime);
      if (typeof p.level === 'string') this.level.set(p.level);
      if (Array.isArray(p.onIds)) this.savedOnIds = new Set<string>(p.onIds);
    } catch { /* ignore malformed prefs */ }
  }

  private deepLinkSet(containers: ContainerSummary[]): Set<string> | null {
    const qp = this.route.snapshot.queryParamMap;
    const raw = [qp.get('container'), qp.get('containers')].filter(Boolean).join(',');
    if (!raw) return null;
    const wanted = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!wanted.length) return null;
    const set = new Set<string>();
    for (const c of containers) {
      const name = c.Names[0]?.replace('/', '') ?? '';
      if (wanted.some(w => c.Id === w || c.Id.startsWith(w) || name === w)) set.add(c.Id);
    }
    return set.size ? set : null;
  }
}

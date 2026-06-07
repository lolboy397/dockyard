import { Component, OnInit, OnDestroy, ElementRef, ViewChild, HostListener, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { forkJoin, Subscription } from 'rxjs';
import { Router } from '@angular/router';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent, statusTone } from '../shared/status-dot/status-dot.component';
import { DockerService } from '../../services/docker.service';
import { WebSocketService, ContainerStatSummary } from '../../services/websocket.service';

type NodeKind = 'network' | 'container' | 'volume';

interface TopoNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub: string;
  x: number; y: number; w: number; h: number;
  state?: string;     // container state
  ports?: string;     // published ports summary
  cid?: string;       // container id (stats key + nav)
  raw: any;           // original docker object (detail panel)
}

interface Lane {
  project: string;
  x: number; y: number; w: number; h: number;
  running: number; total: number;
}

interface TopoEdge {
  id: string;
  d: string;
  kind: 'net' | 'vol';
  from: string; to: string;
}

/**
 * Topology — an interactive infrastructure map. Containers are grouped into
 * compose-project lanes between a column of networks (left) and volumes (right).
 * Cards carry live CPU/mem from the /ws/allstats stream; the graph supports
 * pan/zoom, hover-focus highlighting, a detail panel, and live event refresh.
 */
@Component({
  selector: 'app-topology',
  standalone: true,
  imports: [CommonModule, IconComponent, StatusDotComponent],
  styleUrls: ['./topology.component.scss'],
  templateUrl: './topology.component.html',
})
export class TopologyComponent implements OnInit, OnDestroy {
  @ViewChild('viewport') viewport?: ElementRef<HTMLElement>;

  loading = signal(true);
  nodes = signal<TopoNode[]>([]);
  lanes = signal<Lane[]>([]);
  edges = signal<TopoEdge[]>([]);
  canvasW = signal(1000);
  canvasH = signal(600);
  counts = signal({ net: 0, con: 0, vol: 0 });
  statsMap = signal<Map<string, ContainerStatSummary>>(new Map());
  hoverId = signal<string | null>(null);
  selected = signal<TopoNode | null>(null);
  search = signal('');
  hideStopped = signal(false);

  // view transform
  scale = signal(1);
  tx = signal(20);
  ty = signal(16);
  canvasTransform = computed(() => `translate(${this.tx()}px, ${this.ty()}px) scale(${this.scale()})`);

  health = computed(() => {
    let running = 0, stopped = 0;
    for (const n of this.nodes()) {
      if (n.kind !== 'container') continue;
      if (n.state === 'running') running++; else stopped++;
    }
    return { running, stopped };
  });

  panning = false;
  private adjacency = new Map<string, Set<string>>();
  private raw: { containers: any[]; networks: any[]; volumes: any[] } = { containers: [], networks: [], volumes: [] };
  private statsSub?: Subscription;
  private eventSub?: Subscription;
  private reloadTimer?: ReturnType<typeof setTimeout>;

  // layout constants
  readonly padTop = 56;
  readonly netX = 28; readonly netW = 196;
  readonly laneX = 296; readonly cardW = 240; readonly lanePad = 14; readonly laneW = 268;
  readonly volX = 736; readonly volW = 196;
  readonly cardSlot = 68; readonly cardGap = 12;
  readonly laneHeader = 38; readonly laneGap = 26;
  readonly sideH = 58;

  constructor(private docker: DockerService, private ws: WebSocketService, private router: Router) {}

  ngOnInit(): void {
    this.load();
    this.statsSub = this.ws.streamAllStats().subscribe({
      next: arr => { const m = new Map<string, ContainerStatSummary>(); (arr || []).forEach(s => m.set(s.id, s)); this.statsMap.set(m); },
      error: () => { /* stats are best-effort */ },
    });
    // Live structural changes (start/stop/create/destroy) → debounced reload.
    this.eventSub = this.ws.streamDockerEvents().subscribe({
      next: () => this.scheduleReload(),
      error: () => { /* ignore — refresh button is the fallback */ },
    });
  }

  ngOnDestroy(): void {
    this.statsSub?.unsubscribe();
    this.eventSub?.unsubscribe();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.load(true), 1200);
  }

  load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    forkJoin({
      containers: this.docker.listContainers(true),
      networks: this.docker.listNetworks(),
      volumes: this.docker.listVolumes(),
    }).subscribe({
      next: ({ containers, networks, volumes }) => {
        this.raw = {
          containers: (containers as any[]) || [],
          networks: (networks as any[]) || [],
          volumes: ((volumes as any)?.Volumes || []) as any[],
        };
        this.counts.set({ net: this.raw.networks.length, con: this.raw.containers.length, vol: this.raw.volumes.length });
        this.relayout();
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  onSearch(e: Event): void { this.search.set((e.target as HTMLInputElement).value); this.relayout(); }
  toggleHideStopped(): void { this.hideStopped.set(!this.hideStopped()); this.relayout(); }

  /** Build lanes, nodes and edges from the raw lists honouring search/filter, then fit the view. */
  private relayout(): void {
    const q = this.search().trim().toLowerCase();
    const matches = (s: string) => !q || (s || '').toLowerCase().includes(q);

    let containers = this.raw.containers.filter(c => matches(this.cname(c)) || matches(c.Image));
    if (this.hideStopped()) containers = containers.filter(c => c.State === 'running');
    const networks = this.raw.networks.filter(n => matches(n.Name));
    const volumes = this.raw.volumes.filter(v => matches(v.Name));

    const nodes: TopoNode[] = [];
    const idx: Record<string, TopoNode> = {};
    const lanes: Lane[] = [];

    // group containers by compose project
    const groups = new Map<string, any[]>();
    for (const c of containers) {
      const proj = (c.Labels?.['com.docker.compose.project'] as string) || 'Standalone';
      if (!groups.has(proj)) groups.set(proj, []);
      groups.get(proj)!.push(c);
    }
    const projNames = [...groups.keys()].sort((a, b) => {
      if (a === 'Standalone') return 1;
      if (b === 'Standalone') return -1;
      return a.localeCompare(b);
    });

    let y = this.padTop;
    for (const proj of projNames) {
      const cs = groups.get(proj)!;
      const laneH = this.laneHeader + this.lanePad * 2 + cs.length * this.cardSlot + (cs.length - 1) * this.cardGap;
      let running = 0;
      let cy = y + this.laneHeader + this.lanePad;
      for (const c of cs) {
        if (c.State === 'running') running++;
        const node: TopoNode = {
          id: 'c:' + c.Id, kind: 'container', label: this.cname(c), sub: this.shortImage(c.Image),
          x: this.laneX + this.lanePad, y: cy, w: this.cardW, h: this.cardSlot - 2,
          state: c.State, ports: this.portsOf(c), cid: c.Id, raw: c,
        };
        nodes.push(node); idx[node.id] = node;
        cy += this.cardSlot + this.cardGap;
      }
      lanes.push({ project: proj, x: this.laneX, y, w: this.laneW, h: laneH, running, total: cs.length });
      y += laneH + this.laneGap;
    }
    const centerBottom = Math.max(y - this.laneGap, this.padTop + 160);

    // networks (left) and volumes (right) distributed down the full height
    this.placeColumn(networks.map(n => ({
      id: 'net:' + n.Name, kind: 'network' as NodeKind, label: this.short(n.Name),
      sub: `${n.Driver || 'bridge'} · ${Object.keys(n.Containers || {}).length} attached`, raw: n,
    })), nodes, idx, this.netX, this.netW, this.padTop, centerBottom);

    this.placeColumn(volumes.map(v => ({
      id: 'vol:' + v.Name, kind: 'volume' as NodeKind, label: this.short(v.Name),
      sub: `${v.Driver || 'local'}`, raw: v,
    })), nodes, idx, this.volX, this.volW, this.padTop, centerBottom);

    // edges
    const edges: TopoEdge[] = [];
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      (adj.get(a) || adj.set(a, new Set()).get(a)!).add(b);
      (adj.get(b) || adj.set(b, new Set()).get(b)!).add(a);
    };
    for (const c of containers) {
      const cn = idx['c:' + c.Id];
      if (!cn) continue;
      const nets = c.NetworkSettings?.Networks ? Object.keys(c.NetworkSettings.Networks) : [];
      for (const net of nets) {
        const nn = idx['net:' + net];
        if (!nn) continue;
        edges.push({ id: `${nn.id}>${cn.id}`, kind: 'net', from: nn.id, to: cn.id,
          d: this.curve(nn.x + nn.w, nn.y + nn.h / 2, cn.x, cn.y + cn.h / 2) });
        link(nn.id, cn.id);
      }
      for (const m of (c.Mounts || [])) {
        if (m.Type !== 'volume' || !m.Name) continue;
        const vn = idx['vol:' + m.Name];
        if (!vn) continue;
        edges.push({ id: `${cn.id}>${vn.id}`, kind: 'vol', from: cn.id, to: vn.id,
          d: this.curve(cn.x + cn.w, cn.y + cn.h / 2, vn.x, vn.y + vn.h / 2) });
        link(cn.id, vn.id);
      }
    }

    this.adjacency = adj;
    this.lanes.set(lanes);
    this.nodes.set(nodes);
    this.edges.set(edges);
    this.canvasW.set(this.volX + this.volW + 40);
    this.canvasH.set(Math.max(centerBottom, this.padTop + 160) + 40);
    if (this.selected() && !idx[this.selected()!.id]) this.selected.set(null);
    // Defer until the viewport has its final laid-out size (matters on first
    // load and when the viewport width changes, e.g. mobile).
    setTimeout(() => this.fitView(), 60);
  }

  private placeColumn(items: Array<Omit<TopoNode, 'x' | 'y' | 'w' | 'h'>>, nodes: TopoNode[],
                      idx: Record<string, TopoNode>, x: number, w: number, top: number, bottom: number): void {
    const m = items.length;
    const slot = (bottom - top) / Math.max(m, 1);
    items.forEach((it, i) => {
      const node: TopoNode = { ...it, x, w, h: this.sideH, y: top + i * slot + slot / 2 - this.sideH / 2 };
      nodes.push(node); idx[node.id] = node;
    });
  }

  // ── interaction ──────────────────────────────────────────────────────────────
  onPanStart(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.node-card, .detail')) return;
    this.panning = true;
    const sx = e.clientX, sy = e.clientY, tx0 = this.tx(), ty0 = this.ty();
    const move = (ev: MouseEvent) => { this.tx.set(tx0 + (ev.clientX - sx)); this.ty.set(ty0 + (ev.clientY - sy)); };
    const up = () => { this.panning = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const s0 = this.scale();
    const s1 = Math.min(2.5, Math.max(0.3, s0 * (e.deltaY > 0 ? 0.9 : 1.1)));
    this.tx.set(cx - (cx - this.tx()) * (s1 / s0));
    this.ty.set(cy - (cy - this.ty()) * (s1 / s0));
    this.scale.set(s1);
  }

  // ── touch: one-finger pan, two-finger pinch-zoom ─────────────────────────────
  private touchMode: 'none' | 'pan' | 'pinch' = 'none';
  private tStartX = 0; private tStartY = 0; private tStartTx = 0; private tStartTy = 0;
  private pinchDist0 = 1; private pinchScale0 = 1; private pinchCx = 0; private pinchCy = 0;

  onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 1) {
      if ((e.target as HTMLElement).closest('.node-card, .detail')) { this.touchMode = 'none'; return; }
      this.touchMode = 'pan';
      this.tStartX = e.touches[0].clientX; this.tStartY = e.touches[0].clientY;
      this.tStartTx = this.tx(); this.tStartTy = this.ty();
    } else if (e.touches.length === 2) {
      this.touchMode = 'pinch';
      this.pinchDist0 = this.touchDist(e) || 1;
      this.pinchScale0 = this.scale();
      this.tStartTx = this.tx(); this.tStartTy = this.ty();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.pinchCx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      this.pinchCy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      e.preventDefault();
    }
  }

  onTouchMove(e: TouchEvent): void {
    if (this.touchMode === 'pan' && e.touches.length === 1) {
      this.tx.set(this.tStartTx + (e.touches[0].clientX - this.tStartX));
      this.ty.set(this.tStartTy + (e.touches[0].clientY - this.tStartY));
      e.preventDefault();
    } else if (this.touchMode === 'pinch' && e.touches.length === 2) {
      const s1 = Math.min(2.5, Math.max(0.3, this.pinchScale0 * (this.touchDist(e) / this.pinchDist0)));
      this.tx.set(this.pinchCx - (this.pinchCx - this.tStartTx) * (s1 / this.pinchScale0));
      this.ty.set(this.pinchCy - (this.pinchCy - this.tStartTy) * (s1 / this.pinchScale0));
      this.scale.set(s1);
      e.preventDefault();
    }
  }

  onTouchEnd(e: TouchEvent): void { if (e.touches.length === 0) this.touchMode = 'none'; }

  private touchDist(e: TouchEvent): number {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  zoomBy(factor: number): void {
    const vp = this.viewport?.nativeElement;
    const cx = vp ? vp.clientWidth / 2 : 400, cy = vp ? vp.clientHeight / 2 : 300;
    const s0 = this.scale();
    const s1 = Math.min(2.5, Math.max(0.3, s0 * factor));
    this.tx.set(cx - (cx - this.tx()) * (s1 / s0));
    this.ty.set(cy - (cy - this.ty()) * (s1 / s0));
    this.scale.set(s1);
  }

  fitView(): void {
    const vp = this.viewport?.nativeElement;
    if (!vp) return;
    const sw = (vp.clientWidth - 40) / this.canvasW();
    const sh = (vp.clientHeight - 40) / this.canvasH();
    const s = Math.max(0.3, Math.min(1, sw, sh));
    this.scale.set(s);
    this.tx.set(Math.max(20, (vp.clientWidth - this.canvasW() * s) / 2));
    this.ty.set(Math.max(16, (vp.clientHeight - this.canvasH() * s) / 2));
  }

  select(n: TopoNode, e: Event): void { e.stopPropagation(); this.selected.set(this.selected()?.id === n.id ? null : n); }
  openContainers(): void { this.router.navigate(['/containers']); }

  // ── hover focus ──────────────────────────────────────────────────────────────
  isDimmed(id: string): boolean {
    const h = this.hoverId();
    if (!h || h === id) return false;
    return !this.adjacency.get(h)?.has(id);
  }
  edgeActive(e: TopoEdge): boolean {
    const h = this.hoverId();
    return !!h && (e.from === h || e.to === h);
  }

  // ── live stats ───────────────────────────────────────────────────────────────
  cpuOf(id?: string): string { const s = id ? this.statsMap().get(id) : undefined; return s ? `${s.cpu.toFixed(1)}%` : '—'; }
  memOf(id?: string): string { const s = id ? this.statsMap().get(id) : undefined; return s ? this.fmtBytes(s.mem) : '—'; }

  // ── detail rows ──────────────────────────────────────────────────────────────
  detailRows(n: TopoNode): { k: string; v: string }[] {
    if (n.kind === 'container') {
      const c = n.raw;
      const nets = c.NetworkSettings?.Networks ? Object.keys(c.NetworkSettings.Networks) : [];
      const vols = (c.Mounts || []).filter((m: any) => m.Type === 'volume' && m.Name).map((m: any) => m.Name);
      const st = this.statsMap().get(c.Id);
      return [
        { k: 'State', v: c.Status || c.State || '—' },
        { k: 'Image', v: this.shortImage(c.Image) },
        { k: 'CPU', v: st ? `${st.cpu.toFixed(1)}%` : '—' },
        { k: 'Memory', v: st ? `${this.fmtBytes(st.mem)} / ${this.fmtBytes(st.mem_limit)}` : '—' },
        { k: 'Ports', v: n.ports || '—' },
        { k: 'Networks', v: nets.join(', ') || '—' },
        { k: 'Volumes', v: vols.join(', ') || '—' },
      ];
    }
    if (n.kind === 'network') {
      const nw = n.raw;
      return [
        { k: 'Driver', v: nw.Driver || '—' },
        { k: 'Scope', v: nw.Scope || '—' },
        { k: 'Internal', v: nw.Internal ? 'yes' : 'no' },
        { k: 'Attached', v: String(Object.keys(nw.Containers || {}).length) },
        { k: 'Subnet', v: nw.IPAM?.Config?.[0]?.Subnet || '—' },
      ];
    }
    const v = n.raw;
    return [
      { k: 'Driver', v: v.Driver || '—' },
      { k: 'Mountpoint', v: v.Mountpoint || '—' },
      { k: 'Scope', v: v.Scope || '—' },
    ];
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  dotTone(state?: string) { return statusTone(state || ''); }
  accent(n: TopoNode): string {
    if (n.kind === 'network') return 'var(--info-400)';
    if (n.kind === 'volume') return 'var(--warn-400)';
    if (n.state === 'running') return 'var(--running-400)';
    if (n.state === 'paused' || n.state === 'restarting') return 'var(--warn-400)';
    if (n.state === 'exited' || n.state === 'dead') return 'var(--danger-400)';
    return 'var(--idle-400)';
  }
  private curve(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(36, Math.abs(x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  private cname(c: any): string { return (c.Names?.[0] || c.Id).replace('/', '').slice(0, 26); }
  private short(s: string): string { return s && s.length > 22 ? s.slice(0, 11) + '…' + s.slice(-6) : s; }
  private shortImage(img: string): string {
    if (!img) return '';
    const noDigest = img.split('@')[0];
    const parts = noDigest.split('/');
    return parts[parts.length - 1].slice(0, 28);
  }
  private portsOf(c: any): string {
    const seen = new Set<string>();
    (c.Ports || []).forEach((p: any) => { if (p.PublicPort) seen.add(`${p.PublicPort}→${p.PrivatePort}`); });
    const arr = [...seen];
    if (!arr.length) return '';
    return arr.slice(0, 2).join('  ') + (arr.length > 2 ? `  +${arr.length - 2}` : '');
  }
  private fmtBytes(n: number): string {
    if (!n || n < 0) return '0';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`;
  }
}

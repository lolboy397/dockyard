import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, interval } from 'rxjs';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';
import { WebSocketService, ContainerStatSummary } from '../../services/websocket.service';
import { DockerService } from '../../services/docker.service';
import { HostStats } from '../../models/docker.models';

interface SparkMetric {
  key: 'cpu' | 'mem' | 'disk' | 'net';
  label: string;
  value: string;
  foot: string;
  series: number[];
  color: string;
  unit: 'pct' | 'rate';
}

interface NetRate { id: string; name: string; rx: number; tx: number; }

@Component({
  selector: 'app-metrics',
  standalone: true,
  imports: [CommonModule, StatusDotComponent],
  styleUrls: ['./metrics.component.scss'],
  templateUrl: './metrics.component.html',
})
export class MetricsComponent implements OnInit, OnDestroy {
  updateInterval = 3;
  host: HostStats | null = null;
  topContainers: ContainerStatSummary[] = [];   // CPU-sorted (chart + memory bars)
  topNet: NetRate[] = [];                        // network-sorted

  private statsSub?: Subscription;
  private hostSub?: Subscription;

  private readonly WINDOW = 60;          // sparkline points
  private readonly CHART_SAMPLES = 24;   // per-container CPU chart points
  private cpuHistories = new Map<string, number[]>();
  private sampleTimes: string[] = [];

  // Network rate derivation (cumulative counters → per-interval throughput).
  private prevNet = new Map<string, { rx: number; tx: number }>();
  private prevNetTime = 0;
  netRxRate = 0;
  netTxRate = 0;

  private readonly COLORS = ['#22D3EE', '#34D399', '#60A5FA', '#FBBF24', '#A78BFA', '#F472B6'];
  private colorMap = new Map<string, string>();

  // Tooltip state
  sparkTipX = 0;
  sparkTipY = 0;
  sparkTooltip = { visible: false, cardIndex: -1, x: 0, y: 0, value: '', label: '', color: '' };
  cpuTipX = 0;
  cpuTipDots: { x: number; y: number; color: string }[] = [];
  cpuTooltip = { visible: false, x: 0, y: 0, items: [] as { name: string; value: string; color: string }[] };

  metrics: SparkMetric[] = [
    { key: 'cpu',  label: 'CPU',     value: '—', foot: 'host load',        series: [], color: '#22D3EE', unit: 'pct'  },
    { key: 'mem',  label: 'Memory',  value: '—', foot: 'used / total',     series: [], color: '#34D399', unit: 'pct'  },
    { key: 'disk', label: 'Disk',    value: '—', foot: 'used / total',     series: [], color: '#A78BFA', unit: 'pct'  },
    { key: 'net',  label: 'Network', value: '—', foot: '↓ in · ↑ out',     series: [], color: '#60A5FA', unit: 'rate' },
  ];

  get maxMem(): number { return Math.max(...this.topContainers.map(c => c.mem), 1); }
  get maxNet(): number { return Math.max(...this.topNet.map(n => n.rx + n.tx), 1); }

  constructor(private ws: WebSocketService, private docker: DockerService) {}

  ngOnInit(): void {
    this.loadHistory();
    this.loadHost();
    this.hostSub = interval(this.updateInterval * 1000).subscribe(() => this.loadHost());
    this.statsSub = this.ws.streamAllStats().subscribe(stats => this.onStats(stats));
  }

  ngOnDestroy(): void {
    this.statsSub?.unsubscribe();
    this.hostSub?.unsubscribe();
  }

  // Seed the CPU/Memory/Disk sparklines from the persisted host time-series so the
  // charts show real history immediately instead of filling from zero.
  private loadHistory(): void {
    this.docker.getMetricsHistory(3600).subscribe({
      next: samples => {
        const recent = samples.slice(-this.WINDOW);
        this.setSeries('cpu', recent.map(s => s.cpu_pct));
        this.setSeries('mem', recent.map(s => s.mem_total ? (s.mem_used / s.mem_total) * 100 : 0));
        this.setSeries('disk', recent.map(s => s.disk_total ? (s.disk_used / s.disk_total) * 100 : 0));
      },
      error: () => { /* non-fatal — series fill live */ },
    });
  }

  // Poll live host CPU/memory/disk and append to the sliding sparkline windows.
  private loadHost(): void {
    this.docker.getHostStats().subscribe({
      next: h => {
        this.host = h;
        const memPct = h.mem_total ? (h.mem_used / h.mem_total) * 100 : 0;
        const diskPct = h.disk_total ? (h.disk_used / h.disk_total) * 100 : 0;
        this.pushSeries('cpu', h.cpu_pct);
        this.pushSeries('mem', memPct);
        this.pushSeries('disk', diskPct);

        this.setCard('cpu', `${h.cpu_pct.toFixed(0)}%`, `${h.cpu_cores} core${h.cpu_cores === 1 ? '' : 's'}`);
        this.setCard('mem', `${memPct.toFixed(0)}%`, `${this.formatBytes(h.mem_used)} / ${this.formatBytes(h.mem_total)}`);
        this.setCard('disk', `${diskPct.toFixed(0)}%`, `${this.formatBytes(h.disk_used)} / ${this.formatBytes(h.disk_total)}`);
      },
      error: () => { /* transient */ },
    });
  }

  private onStats(stats: ContainerStatSummary[]): void {
    this.topContainers = [...stats].sort((a, b) => b.cpu - a.cpu).slice(0, 8);

    // Per-container CPU history for the line chart.
    const ts = new Date().toTimeString().slice(0, 8);
    this.sampleTimes = [...this.sampleTimes.slice(-(this.CHART_SAMPLES - 1)), ts];
    for (const c of this.topContainers) {
      const hist = this.cpuHistories.get(c.id) ?? Array(this.CHART_SAMPLES).fill(0);
      this.cpuHistories.set(c.id, [...hist.slice(1), c.cpu]);
    }

    // Network: cumulative byte counters → throughput, derived per container so a
    // container starting/stopping (or a counter reset) doesn't spike the total.
    const now = Date.now();
    const dt = this.prevNetTime ? (now - this.prevNetTime) / 1000 : 0;
    let aggRx = 0, aggTx = 0;
    const cur = new Map<string, { rx: number; tx: number }>();
    const rates: NetRate[] = [];
    for (const c of stats) {
      cur.set(c.id, { rx: c.net_rx, tx: c.net_tx });
      const p = this.prevNet.get(c.id);
      let rxr = 0, txr = 0;
      if (p && dt > 0) {
        if (c.net_rx >= p.rx) rxr = (c.net_rx - p.rx) / dt;
        if (c.net_tx >= p.tx) txr = (c.net_tx - p.tx) / dt;
      }
      aggRx += rxr; aggTx += txr;
      rates.push({ id: c.id, name: c.name, rx: rxr, tx: txr });
    }
    this.prevNet = cur;
    this.prevNetTime = now;

    if (dt > 0) {   // skip the first sample (no baseline yet)
      this.netRxRate = aggRx;
      this.netTxRate = aggTx;
      this.pushSeries('net', aggRx + aggTx);
      this.setCard('net', this.formatRate(aggRx + aggTx), `↓ ${this.formatRate(aggRx)}   ↑ ${this.formatRate(aggTx)}`);
      this.topNet = rates.filter(r => r.rx + r.tx > 0).sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx)).slice(0, 6);
    }
  }

  // ── Series helpers ──────────────────────────────────────────────────────────

  private card(key: SparkMetric['key']): SparkMetric | undefined {
    return this.metrics.find(m => m.key === key);
  }
  private setCard(key: SparkMetric['key'], value: string, foot: string): void {
    const m = this.card(key);
    if (m) { m.value = value; m.foot = foot; }
  }
  private setSeries(key: SparkMetric['key'], arr: number[]): void {
    const m = this.card(key);
    if (m && arr.length) { m.series = arr.slice(-this.WINDOW); }
  }
  private pushSeries(key: SparkMetric['key'], val: number): void {
    const m = this.card(key);
    if (!m) return;
    const next = [...m.series, val];
    m.series = next.length > this.WINDOW ? next.slice(next.length - this.WINDOW) : next;
  }

  // ── Tooltips ────────────────────────────────────────────────────────────────

  onSparkMove(event: MouseEvent, cardIndex: number, m: SparkMetric): void {
    if (m.series.length < 2) return;
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const relX = event.clientX - rect.left;
    const idx = Math.max(0, Math.min(Math.round((relX / rect.width) * (m.series.length - 1)), m.series.length - 1));
    const val = m.series[idx] ?? 0;
    const max = Math.max(...m.series, m.unit === 'pct' ? 100 : 1);
    this.sparkTipX = (idx / (m.series.length - 1)) * 200;
    this.sparkTipY = 60 - (val / max) * (60 - 6) - 2;
    const formatted = m.unit === 'rate' ? this.formatRate(val) : `${val.toFixed(1)}%`;
    this.sparkTooltip = { visible: true, cardIndex, x: event.clientX + 14, y: event.clientY - 44, value: formatted, label: m.label, color: m.color };
  }

  onSparkLeave(): void {
    this.sparkTooltip = { ...this.sparkTooltip, visible: false };
  }

  onCpuMove(event: MouseEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const relX = event.clientX - rect.left;
    const idx = Math.max(0, Math.min(Math.round((relX / rect.width) * (this.CHART_SAMPLES - 1)), this.CHART_SAMPLES - 1));
    const allVals = Array.from(this.cpuHistories.values()).flatMap(h => h);
    const maxVal = Math.max(...allVals, 0.1);
    this.cpuTipX = (relX / rect.width) * 600;
    const items = this.topContainers.slice(0, 4).map(c => {
      const hist = this.cpuHistories.get(c.id) ?? Array(this.CHART_SAMPLES).fill(0);
      return { name: c.name, value: `${(hist[idx] ?? 0).toFixed(1)}%`, color: this.containerColor(c.id) };
    });
    this.cpuTipDots = this.topContainers.slice(0, 4).map(c => {
      const hist = this.cpuHistories.get(c.id) ?? Array(this.CHART_SAMPLES).fill(0);
      const val = hist[idx] ?? 0;
      return { x: (idx / (this.CHART_SAMPLES - 1)) * 600, y: 130 - (val / maxVal) * 120, color: this.containerColor(c.id) };
    });
    this.cpuTooltip = { visible: true, x: event.clientX + 14, y: event.clientY - 14, items };
  }

  onCpuLeave(): void {
    this.cpuTooltip = { ...this.cpuTooltip, visible: false };
    this.cpuTipDots = [];
  }

  containerColor(id: string): string {
    if (!this.colorMap.has(id)) {
      this.colorMap.set(id, this.COLORS[this.colorMap.size % this.COLORS.length]);
    }
    return this.colorMap.get(id)!;
  }

  // ── SVG path builders ─────────────────────────────────────────────────────────

  // Catmull-Rom spline control-point commands for pts[1..N-1]
  private splineCmds(pts: [number, number][]): string {
    let d = '';
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  linePath(series: number[], unit: SparkMetric['unit'] = 'pct'): string {
    if (series.length < 2) return '';
    const max = unit === 'rate' ? Math.max(...series, 1) : 100;
    const w = 200, h = 60;
    const pts = series.map((v, i) => [
      (i * w) / (series.length - 1),
      h - (Math.min(v, max) / max) * (h - 6) - 2,
    ] as [number, number]);
    return `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}${this.splineCmds(pts)}`;
  }

  fillPath(series: number[], unit: SparkMetric['unit'] = 'pct'): string {
    if (series.length < 2) return '';
    const max = unit === 'rate' ? Math.max(...series, 1) : 100;
    const w = 200, h = 60;
    const pts = series.map((v, i) => [
      (i * w) / (series.length - 1),
      h - (Math.min(v, max) / max) * (h - 6) - 2,
    ] as [number, number]);
    return `M 0,${h} L ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}${this.splineCmds(pts)} L ${w},${h} Z`;
  }

  cpuChartPath(id: string): string {
    const hist = this.cpuHistories.get(id) ?? Array(this.CHART_SAMPLES).fill(0);
    const allVals = Array.from(this.cpuHistories.values()).flatMap(h => h);
    const maxVal = Math.max(...allVals, 0.1);
    const w = 600, baseline = 130, amplitude = 120;
    const pts = hist.map((v, i) => [
      (i * w) / (this.CHART_SAMPLES - 1),
      baseline - (v / maxVal) * amplitude,
    ] as [number, number]);
    return `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}${this.splineCmds(pts)}`;
  }

  timeAxisLabels(): string[] {
    const n = this.sampleTimes.length;
    if (n < 2) return ['—', '—', '—', '—'];
    const indices = [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1];
    return indices.map(i => this.sampleTimes[i] ?? '—');
  }

  // ── Formatting ────────────────────────────────────────────────────────────────

  formatBytes(bytes: number): string {
    if (!bytes || bytes < 1) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  formatRate(bytesPerSec: number): string {
    return `${this.formatBytes(bytesPerSec)}/s`;
  }
}

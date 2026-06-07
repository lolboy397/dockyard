import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, interval } from 'rxjs';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';
import { WebSocketService, ContainerStatSummary } from '../../services/websocket.service';
import { DockerService } from '../../services/docker.service';

interface SparkMetric {
  label: string;
  value: string;
  foot: string;
  series: number[];
  color: string;
  unit: 'pct' | 'mb';
}

@Component({
  selector: 'app-metrics',
  standalone: true,
  imports: [CommonModule, StatusDotComponent],
  styleUrls: ['./metrics.component.scss'],
  templateUrl: './metrics.component.html',
})
export class MetricsComponent implements OnInit, OnDestroy {
  updateInterval = 3;
  topContainers: ContainerStatSummary[] = [];
  private statsSub?: Subscription;

  private readonly CHART_SAMPLES = 24;
  private cpuHistories = new Map<string, number[]>();
  private sampleTimes: string[] = [];

  private cpuHistory: number[] = Array(12).fill(0);
  private memHistory: number[] = Array(12).fill(0);
  private netRxHistory: number[] = Array(12).fill(0);
  private netTxHistory: number[] = Array(12).fill(0);

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
    { label: 'CPU total', value: '—', foot: 'across all containers', series: Array(12).fill(0), color: '#22D3EE', unit: 'pct' },
    { label: 'Memory', value: '—', foot: 'resident set across all containers', series: Array(12).fill(0), color: '#34D399', unit: 'mb' },
    { label: 'Net in',  value: '—', foot: 'cumulative rx', series: Array(12).fill(0), color: '#60A5FA', unit: 'pct' },
    { label: 'Net out', value: '—', foot: 'cumulative tx', series: Array(12).fill(0), color: '#FBBF24', unit: 'pct' },
  ];

  get maxCpu(): number { return Math.max(...this.topContainers.map(c => c.cpu), 0.1); }
  get maxMem(): number { return Math.max(...this.topContainers.map(c => c.mem), 1); }

  constructor(private ws: WebSocketService, private docker: DockerService) {}

  ngOnInit(): void {
    this.statsSub = this.ws.streamAllStats().subscribe(stats => {
      this.topContainers = [...stats].sort((a, b) => b.cpu - a.cpu).slice(0, 8);

      const totalCpu = stats.reduce((s, c) => s + c.cpu, 0);
      const totalMem = stats.reduce((s, c) => s + c.mem, 0);

      this.cpuHistory = [...this.cpuHistory.slice(1), totalCpu];
      this.memHistory = [...this.memHistory.slice(1), totalMem / (1024 * 1024)];

      this.metrics[0].value = `${totalCpu.toFixed(1)}%`;
      this.metrics[0].series = [...this.cpuHistory];
      this.metrics[1].value = this.formatBytes(totalMem);
      this.metrics[1].series = [...this.memHistory];

      // Track per-container CPU history for line chart
      const ts = new Date().toTimeString().slice(0, 8);
      this.sampleTimes = [...this.sampleTimes.slice(-(this.CHART_SAMPLES - 1)), ts];
      for (const c of this.topContainers) {
        const hist = this.cpuHistories.get(c.id) ?? Array(this.CHART_SAMPLES).fill(0);
        this.cpuHistories.set(c.id, [...hist.slice(1), c.cpu]);
      }
    });
  }

  ngOnDestroy(): void {
    this.statsSub?.unsubscribe();
  }

  onSparkMove(event: MouseEvent, cardIndex: number, m: SparkMetric): void {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const relX = event.clientX - rect.left;
    const idx = Math.max(0, Math.min(Math.round((relX / rect.width) * (m.series.length - 1)), m.series.length - 1));
    const val = m.series[idx] ?? 0;
    const max = Math.max(...m.series, 1);
    this.sparkTipX = (idx / (m.series.length - 1)) * 200;
    this.sparkTipY = 60 - (val / max) * (60 - 6) - 2;
    const formatted = m.unit === 'pct' ? `${val.toFixed(1)}%` : `${val.toFixed(0)} MB`;
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

  linePath(series: number[]): string {
    const max = Math.max(...series, 1);
    const w = 200, h = 60;
    const pts = series.map((v, i) => [
      (i * w) / (series.length - 1),
      h - (v / max) * (h - 6) - 2
    ] as [number, number]);
    return `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}${this.splineCmds(pts)}`;
  }

  fillPath(series: number[]): string {
    const max = Math.max(...series, 1);
    const w = 200, h = 60;
    const pts = series.map((v, i) => [
      (i * w) / (series.length - 1),
      h - (v / max) * (h - 6) - 2
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
      baseline - (v / maxVal) * amplitude
    ] as [number, number]);
    return `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}${this.splineCmds(pts)}`;
  }

  timeAxisLabels(): string[] {
    const n = this.sampleTimes.length;
    if (n < 2) return ['—', '—', '—', '—'];
    const indices = [0, Math.floor(n / 3), Math.floor(2 * n / 3), n - 1];
    return indices.map(i => this.sampleTimes[i] ?? '—');
  }

  formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }
}

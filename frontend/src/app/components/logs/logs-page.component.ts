import { Component, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';
import { DockerService } from '../../services/docker.service';
import { WebSocketService, MultiLogStream } from '../../services/websocket.service';

interface LogSource {
  id: string;
  name: string;
  color: string;
  on: boolean;
  count: number;
}

interface LogLine {
  ts: string;
  src: string;
  color: string;
  level: string;
  msg: string;
}

const SOURCE_COLORS = [
  '#22D3EE', '#34D399', '#60A5FA', '#FBBF24',
  '#A78BFA', '#F472B6', '#FB923C', '#4ADE80',
];

@Component({
  selector: 'app-logs-page',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, StatusDotComponent],
  templateUrl: './logs-page.component.html',
})
export class LogsPageComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('logStream') logStreamEl?: ElementRef<HTMLDivElement>;

  sources: LogSource[] = [];
  lines: LogLine[] = [];
  paused = false;
  wrap = false;
  filterText = '';
  level = 'all';
  levels = ['all', 'info', 'warn', 'error'];
  tail = '50';
  tails = ['50', '100', '500', '1000'];

  // ONE multiplexed socket carries every container's logs (instead of one socket
  // per container). Frames are demultiplexed by container id.
  private stream?: MultiLogStream;
  private framesSub?: Subscription;
  private sourceById = new Map<string, LogSource>();

  private shouldScroll = true;
  private lineCountThisSecond = 0;
  lps = 0;
  private lpsInterval?: ReturnType<typeof setInterval>;

  get activeSources(): LogSource[] { return this.sources.filter(s => s.on); }

  get filteredLines(): LogLine[] {
    let result = this.lines;
    if (this.level !== 'all') {
      result = result.filter(l => l.level === this.level || l.level.startsWith(this.level[0]));
    }
    if (this.filterText) {
      const f = this.filterText.toLowerCase();
      result = result.filter(l => l.msg.toLowerCase().includes(f) || l.src.toLowerCase().includes(f));
    }
    return result;
  }

  constructor(private docker: DockerService, private ws: WebSocketService) {}

  ngOnInit(): void {
    this.stream = this.ws.streamMultiLogs();
    this.framesSub = this.stream.frames$.subscribe(frame => {
      const src = this.sourceById.get(frame.id);
      if (!src || !src.on) return;
      src.count++;
      this.lineCountThisSecond++;
      if (!this.paused) this.addLine(frame.data, src);
    });

    this.loadContainers();
    this.lpsInterval = setInterval(() => {
      this.lps = this.lineCountThisSecond;
      this.lineCountThisSecond = 0;
    }, 1000);
  }

  ngOnDestroy(): void {
    this.framesSub?.unsubscribe();
    this.stream?.close();
    if (this.lpsInterval) clearInterval(this.lpsInterval);
  }

  ngAfterViewChecked(): void {
    if (this.shouldScroll && this.logStreamEl) {
      const el = this.logStreamEl.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScroll = false;
    }
  }

  loadContainers(): void {
    this.docker.listContainers(true).subscribe(containers => {
      const prevIds = new Set(this.sourceById.keys());
      const nextIds = new Set(containers.map(c => c.Id));

      // Drop followers for containers that no longer exist.
      for (const id of prevIds) {
        if (!nextIds.has(id)) this.stream?.unsubscribe(id);
      }

      this.sources = containers.map((c, i) => ({
        id: c.Id,
        name: c.Names[0]?.replace('/', '') ?? c.Id.slice(0, 8),
        color: SOURCE_COLORS[i % SOURCE_COLORS.length],
        on: c.State === 'running',
        count: this.sourceById.get(c.Id)?.count ?? 0,
      }));
      this.sourceById = new Map(this.sources.map(s => [s.id, s]));

      // Subscribe the running ones. The backend ignores a duplicate subscribe, so
      // re-running this on refresh won't replay history for already-followed ones.
      this.activeSources.forEach(s => this.stream?.subscribe(s.id, this.tail));
    });
  }

  toggleSource(source: LogSource): void {
    if (source.on) {
      this.stream?.subscribe(source.id, this.tail);
    } else {
      this.stream?.unsubscribe(source.id);
    }
  }

  setAll(on: boolean): void {
    this.sources.forEach(s => {
      if (s.on !== on) { s.on = on; this.toggleSource(s); }
    });
  }

  setTail(t: string): void {
    if (t === this.tail) return;
    this.tail = t;
    // Re-follow active sources so the new history depth takes effect.
    this.activeSources.forEach(s => {
      this.stream?.unsubscribe(s.id);
      this.stream?.subscribe(s.id, this.tail);
    });
  }

  private addLine(raw: string, source: LogSource): void {
    const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const level = /\b(WARN|WARNING)\b/i.test(clean) ? 'warn'
                : /\b(ERROR|ERR|FATAL|CRIT)\b/i.test(clean) ? 'err'
                : 'info';
    this.lines.push({ ts, src: source.name, color: source.color, level, msg: clean.trim() });
    if (this.lines.length > 2000) this.lines = this.lines.slice(-2000);
    this.shouldScroll = true;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  clearLines(): void {
    this.lines = [];
    this.sources.forEach(s => s.count = 0);
  }

  download(): void {
    const text = this.filteredLines
      .map(l => `${l.ts}  ${l.level.toUpperCase().padEnd(5)} ${l.src}  ${l.msg}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dockyard-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
